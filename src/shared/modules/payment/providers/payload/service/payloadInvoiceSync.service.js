'use strict';

const mongoose = require('mongoose');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const OwnerPayloadAutopay = require('../model/ownerPayloadAutopay.model');
const { PayloadClient } = require('../client/payload.client');
const payloadConfig = require('../../../../../../config/payload.config');
const { ENTITY_TYPE, AUDIT_EVENTS } = require('../constants/payload.constants');
const { reconcileInvoiceStoredTotals } = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
const { resolvePayinMerchantContext } = require('../utils/resolvePayloadPayinMerchant.util');
const { calculatePayloadProcessingFee } = require('../utils/payloadPayinFee.util');
const { getEffectiveBillingSettingsForProperty } = require('../../../../billing-settings/service/billingSettings.service');
const { roundMoney } = require('../utils/payloadPayinSettlement.util');
const {
  formatPayloadDueDate,
  isInvoiceEligibleForAutopaySync,
} = require('../utils/payloadInvoiceSync.util');
const {
  buildOwnerAutopayInvoiceMongoFilter,
  isOwnerChargeableForAutopayInvoice,
} = require('../utils/payloadAutopayInvoiceScope.util');
const {
  mirrorAmountExceedsExpected,
  buildMirrorChargeItems,
  MIRROR_AMOUNT_EPSILON,
} = require('../utils/payloadMirrorSafety.util');
const PayloadPaymentMethod = require('../model/payloadPaymentMethod.model');
const { auditPayload } = require('./payloadAudit.helper');
const logger = require('../../../../../../common/logger');

const client = new PayloadClient();

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function unwrapRemoteInvoice(remote) {
  if (!remote || typeof remote !== 'object') return remote;
  if (remote.data && typeof remote.data === 'object') return remote.data;
  return remote;
}

async function resolveSyncAmountsForInvoice(invoice, methodType) {
  await reconcileInvoiceStoredTotals(invoice);
  const invoicePaymentAmount = roundMoney(invoice.balanceDue || 0);
  if (invoicePaymentAmount <= 0) {
    return null;
  }
  const billingSettings = await getEffectiveBillingSettingsForProperty(invoice.propertyId);
  const feeQuote = calculatePayloadProcessingFee({
    invoicePaymentAmount,
    methodType,
    billingSettings,
    applyFee: true,
  });
  return {
    invoicePaymentAmount: feeQuote.invoicePaymentAmount,
    processingFeeAmount: feeQuote.processingFeeAmount,
    chargeAmount: feeQuote.chargeAmount,
    methodType,
  };
}

/**
 * §17.1 — verify mirror amount/due date against PropMV before upsert or after GET.
 */
async function assertMirrorSafeForAutopay({
  invoice,
  enrollment,
  paymentMethod,
  amounts,
  remoteInvoice = null,
}) {
  await reconcileInvoiceStoredTotals(invoice);

  if (!isInvoiceEligibleForAutopaySync(invoice)) {
    return { safe: false, action: 'close', reason: 'invoice_not_eligible' };
  }

  const resolvedAmounts = amounts || await resolveSyncAmountsForInvoice(invoice, paymentMethod?.type || 'CARD');
  if (!resolvedAmounts || resolvedAmounts.chargeAmount <= 0) {
    return { safe: false, action: 'close', reason: 'zero_amount' };
  }

  const expectedCharge = roundMoney(resolvedAmounts.chargeAmount);
  const payloadInvoiceId = String(invoice.payloadAutopayMirror?.payloadInvoiceId || '').trim();
  if (!payloadInvoiceId || !client.isConfigured()) {
    return {
      safe: true,
      action: 'upsert',
      expectedCharge,
      amounts: resolvedAmounts,
    };
  }

  let remote = unwrapRemoteInvoice(remoteInvoice);
  if (!remote) {
    try {
      remote = unwrapRemoteInvoice(await client.getInvoice(payloadInvoiceId));
    } catch (err) {
      logger.warn('[PayloadInvoiceSync] assertMirrorSafe GET failed', {
        invoiceId: String(invoice._id),
        payloadInvoiceId,
        message: err.message,
      });
      return {
        safe: true,
        action: 'upsert',
        expectedCharge,
        amounts: resolvedAmounts,
      };
    }
  }

  const remoteAmountDue = roundMoney(remote?.amount_due ?? remote?.amountDue ?? 0);
  const localDue = formatPayloadDueDate(invoice.dueDate);
  const remoteDue = String(remote?.due_date || remote?.dueDate || '').trim().slice(0, 10);
  const dueMismatch = localDue && remoteDue && localDue !== remoteDue;

  if (mirrorAmountExceedsExpected(remoteAmountDue, expectedCharge)) {
    return {
      safe: false,
      action: 'correct',
      reason: 'mirror_amount_exceeds_expected',
      expectedCharge,
      remoteAmountDue,
      dueMismatch,
      remote,
      amounts: resolvedAmounts,
    };
  }

  if (dueMismatch) {
    return {
      safe: false,
      action: 'correct',
      reason: 'due_date_mismatch',
      expectedCharge,
      remoteAmountDue,
      dueMismatch,
      remote,
      amounts: resolvedAmounts,
    };
  }

  return {
    safe: true,
    action: 'none',
    expectedCharge,
    remoteAmountDue,
    amounts: resolvedAmounts,
    remote,
  };
}

async function disableMirrorAutopayOnInvoice(invoice, payloadInvoiceId, { reason = '' } = {}) {
  if (!payloadInvoiceId || !client.isConfigured()) return;
  try {
    await client.updateInvoice(payloadInvoiceId, {
      autopay_allowed: false,
    });
  } catch (err) {
    logger.warn('[PayloadInvoiceSync] Failed to disable autopay on unsafe mirror', {
      invoiceId: String(invoice._id),
      payloadInvoiceId,
      message: err.message,
    });
  }
  invoice.payloadAutopayMirror = {
    ...(invoice.payloadAutopayMirror || {}),
    syncStatus: reason || 'unsafe_mirror',
    lastSyncError: reason || 'Mirror amount exceeded PropMV balance',
    lastSyncedAt: new Date(),
  };
  await invoice.save();
}

async function upsertPayloadMirrorInvoice({
  invoice,
  enrollment,
  paymentMethod,
}) {
  if (!payloadConfig.payload.ownerAutopayEnabled) {
    return { skipped: true, reason: 'autopay_disabled' };
  }
  if (!client.isConfigured()) {
    return { skipped: true, reason: 'payload_not_configured' };
  }
  if (!isInvoiceEligibleForAutopaySync(invoice)) {
    await closePayloadMirrorInvoice(invoice, { reason: 'invoice_not_eligible' }).catch(() => {});
    return { skipped: true, reason: 'invoice_not_eligible' };
  }

  const userOid = toObjectId(enrollment.userId);
  const methodType = paymentMethod?.type || 'CARD';
  const amounts = await resolveSyncAmountsForInvoice(invoice, methodType);
  if (!amounts || amounts.chargeAmount <= 0) {
    await closePayloadMirrorInvoice(invoice, { reason: 'zero_amount' }).catch(() => {});
    return { skipped: true, reason: 'zero_amount' };
  }

  const safety = await assertMirrorSafeForAutopay({
    invoice,
    enrollment,
    paymentMethod,
    amounts,
    remoteInvoice: null,
  });

  const ctx = await resolvePayinMerchantContext({
    invoice,
    paymentMethodRef: paymentMethod._id,
    userId: userOid,
  });

  const customerId = String(enrollment.payloadCustomerId || '').trim();
  if (!customerId) {
    const err = new Error('Payload customer is missing for autopay sync.');
    err.statusCode = 422;
    throw err;
  }

  const dueDate = formatPayloadDueDate(invoice.dueDate);
  const externalUid = String(invoice._id);
  const description = `HOA invoice ${invoice.invoiceId || externalUid}`.slice(0, 200);
  const attrs = {
    propmvInvoiceId: externalUid,
    propmvUserId: String(enrollment.userId),
    propmvHoaId: String(enrollment.hoaId),
    invoicePaymentAmount: amounts.invoicePaymentAmount,
    processingFeeAmount: amounts.processingFeeAmount,
    chargeAmount: amounts.chargeAmount,
  };

  const existingPayloadId = String(invoice.payloadAutopayMirror?.payloadInvoiceId || '').trim();
  let remoteItems = safety.remote?.items;
  if (existingPayloadId && !remoteItems) {
    try {
      const fetched = unwrapRemoteInvoice(await client.getInvoice(existingPayloadId));
      remoteItems = fetched?.items;
    } catch (_) {
      remoteItems = [];
    }
  }

  const body = {
    customer_id: customerId,
    processing_id: ctx.merchantId,
    due_date: dueDate,
    external_uid: externalUid,
    autopay_allowed: true,
    description,
    status: 'open',
    attrs,
    items: buildMirrorChargeItems({
      remoteItems,
      chargeAmount: amounts.chargeAmount,
      description,
    }),
  };

  let remote;
  try {
    if (existingPayloadId) {
      remote = await client.updateInvoice(existingPayloadId, body);
    } else {
      remote = await client.createInvoice(body);
    }
  } catch (err) {
    if (err?.statusCode === 404 && existingPayloadId) {
      remote = await client.createInvoice(body);
    } else {
      invoice.payloadAutopayMirror = invoice.payloadAutopayMirror || {};
      invoice.payloadAutopayMirror.syncStatus = 'error';
      invoice.payloadAutopayMirror.lastSyncError = err.message || 'Payload invoice sync failed';
      invoice.payloadAutopayMirror.lastSyncedAt = new Date();
      await invoice.save();
      throw err;
    }
  }

  const payloadInvoiceId = String(remote?.id || existingPayloadId || '').trim();

  if (payloadInvoiceId && client.isConfigured()) {
    try {
      const verified = unwrapRemoteInvoice(await client.getInvoice(payloadInvoiceId));
      const verifiedDue = roundMoney(verified?.amount_due ?? verified?.amountDue ?? 0);
      if (mirrorAmountExceedsExpected(verifiedDue, amounts.chargeAmount)) {
        await disableMirrorAutopayOnInvoice(
          invoice,
          payloadInvoiceId,
          { reason: 'mirror_still_exceeds_after_sync' },
        );
        auditPayload({
          event: AUDIT_EVENTS.AUTOPAY_INVOICE_SYNCED,
          entity: 'Invoice',
          entityId: invoice._id,
          success: false,
          failureReason: 'mirror_amount_exceeds_expected',
          after: {
            payloadInvoiceId,
            verifiedDue,
            expectedCharge: amounts.chargeAmount,
          },
        });
        return {
          synced: false,
          unsafe: true,
          payloadInvoiceId,
          reason: 'mirror_still_exceeds_after_sync',
        };
      }
    } catch (verifyErr) {
      logger.warn('[PayloadInvoiceSync] Post-upsert verification failed', {
        invoiceId: String(invoice._id),
        message: verifyErr.message,
      });
    }
  }

  invoice.payloadAutopayMirror = {
    payloadInvoiceId,
    lastSyncedAt: new Date(),
    syncStatus: 'synced',
    lastSyncError: '',
  };
  await invoice.save();

  auditPayload({
    event: AUDIT_EVENTS.AUTOPAY_INVOICE_SYNCED,
    entity: 'Invoice',
    entityId: invoice._id,
    after: {
      payloadInvoiceId,
      dueDate,
      chargeAmount: amounts.chargeAmount,
      userId: String(enrollment.userId),
      corrected: safety.action === 'correct',
    },
  });

  return { synced: true, payloadInvoiceId, remote };
}

async function closePayloadMirrorInvoice(invoice, { reason = '' } = {}) {
  const payloadInvoiceId = String(invoice?.payloadAutopayMirror?.payloadInvoiceId || '').trim();
  if (!payloadInvoiceId || !client.isConfigured()) {
    return { closed: false, reason: 'no_mirror' };
  }
  try {
    await client.updateInvoice(payloadInvoiceId, {
      autopay_allowed: false,
      status: 'closed',
    });
  } catch (err) {
    logger.warn('[PayloadInvoiceSync] Failed to close Payload mirror invoice', {
      invoiceId: String(invoice._id),
      payloadInvoiceId,
      message: err.message,
    });
  }
  invoice.payloadAutopayMirror = {
    ...(invoice.payloadAutopayMirror || {}),
    syncStatus: reason || 'closed',
    lastSyncedAt: new Date(),
    lastSyncError: '',
  };
  await invoice.save();
  return { closed: true, payloadInvoiceId };
}

async function syncOpenInvoicesForOwner({ userId, hoaId, enrollment, paymentMethod }) {
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid) return { synced: 0, errors: [] };

  const filter = await buildOwnerAutopayInvoiceMongoFilter({
    userId: userOid,
    hoaId: hoaOid,
    extra: {
      balanceDue: { $gt: 0 },
    },
  });
  if (!filter) return { synced: 0, errors: [], total: 0 };

  const invoices = await Invoice.find(filter).sort({ dueDate: 1 });

  let synced = 0;
  const errors = [];
  for (const invoice of invoices) {
    try {
      const result = await upsertPayloadMirrorInvoice({ invoice, enrollment, paymentMethod });
      if (result.synced) synced += 1;
    } catch (err) {
      errors.push({ invoiceId: String(invoice._id), message: err.message });
    }
  }
  return { synced, errors, total: invoices.length };
}

async function syncInvoiceIfOwnerEnrolled(invoiceId) {
  if (!payloadConfig.payload.ownerAutopayEnabled) return { skipped: true };
  const invoiceOid = toObjectId(invoiceId);
  if (!invoiceOid) return { skipped: true, reason: 'invalid_invoice' };

  const invoice = await Invoice.findOne({ _id: invoiceOid, isDeleted: { $ne: true } });
  if (!invoice?.hoaId) return { skipped: true, reason: 'no_hoa' };

  const enrollments = await OwnerPayloadAutopay.find({
    hoaId: invoice.hoaId,
    enabled: true,
  }).lean();

  if (!enrollments.length) return { skipped: true, reason: 'no_enrollment' };

  let synced = 0;
  for (const row of enrollments) {
    const chargeable = await isOwnerChargeableForAutopayInvoice({
      userId: row.userId,
      hoaId: row.hoaId,
      invoice,
    });
    if (!chargeable) continue;
    const paymentMethod = row.payloadPaymentMethodLocalId
      ? await PayloadPaymentMethod.findOne({
        _id: row.payloadPaymentMethodLocalId,
        userId: row.userId,
        isDeleted: { $ne: true },
      })
      : null;
    if (!paymentMethod) continue;
    const result = await upsertPayloadMirrorInvoice({
      invoice,
      enrollment: row,
      paymentMethod,
    });
    if (result.synced) synced += 1;
  }
  return { synced };
}

module.exports = {
  formatPayloadDueDate,
  isInvoiceEligibleForAutopaySync,
  assertMirrorSafeForAutopay,
  upsertPayloadMirrorInvoice,
  closePayloadMirrorInvoice,
  syncOpenInvoicesForOwner,
  syncInvoiceIfOwnerEnrolled,
  MIRROR_AMOUNT_EPSILON,
};
