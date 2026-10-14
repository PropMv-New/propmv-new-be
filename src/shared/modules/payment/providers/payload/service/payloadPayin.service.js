'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const PayloadPayin = require('../model/payloadPayin.model');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const User = require('../../../../users/models/user.model');
const { PayloadClient } = require('../client/payload.client');
const {
  ensureGatewayProcessingPaymentRecorded,
  reconcileInvoiceStoredTotals,
  settleInvoiceGatewayPayment,
  failInvoiceGatewayPayment,
} = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
const payloadConfig = require('../../../../../../config/payload.config');
const { ensurePayloadEnabled } = require('./payloadMerchant.service');
const { resolvePayinMerchantContext, assertPaymentMethodForPayin } = require('../utils/resolvePayloadPayinMerchant.util');
const {
  AUDIT_EVENTS,
  PAYIN_STATUS,
} = require('../constants/payload.constants');
const {
  roundMoney,
  dollarsToMinorUnits,
  minorUnitsToDollars,
  normalizePayinStatus,
  invoiceMethodLabel,
  resolvePayloadPayinSettlementAction,
  isCardLikeMethodType,
  isAchLikeMethodType,
} = require('../utils/payloadPayinSettlement.util');
const {
  resolveRemotePaymentMethodType,
  normalizeMethodType,
} = require('../utils/payloadPaymentMethodType.util');
const { detectMultiMerchantPayinIssues } = require('../utils/payloadPayinAllocation.util');
const {
  calculatePayloadProcessingFee,
  validatePayloadPayinAmounts,
  resolveAuthoritativePayloadPayinAmounts,
} = require('../utils/payloadPayinFee.util');
const {
  getEffectiveBillingSettingsForProperty,
} = require('../../../../billing-settings/service/billingSettings.service');
const { auditPayload } = require('./payloadAudit.helper');
const {
  buildPayloadTransactionChargeBody,
  resolvePayloadChargeCustomerId,
  validateRemotePaymentMethodForCharge,
  classifyPayloadPaymentMethodScope,
  resolvePayloadSettlementBankIdForMerchant,
  shouldRetryPayloadChargeWithoutCustomerId,
} = require('../utils/payloadPayinCharge.util');
const ledgerService = require('../../../../../../portals/hoa-board/modules/owners/services/ledger.service');
const logger = require('../../../../../../common/logger');

const client = new PayloadClient();

async function createPayloadPaymentTransactionWithFallback({
  transactionPayload,
  idempotencyKey,
  settlementBankId,
}) {
  try {
    return await client.createPaymentTransaction(transactionPayload, { idempotencyKey });
  } catch (err) {
    const status = Number(err?.statusCode || 0);
    const canRetryWithoutDepositRoute = Boolean(
      settlementBankId
      && transactionPayload?.processing_method_id
      && status >= 400
      && status !== 409
    );

    if (!canRetryWithoutDepositRoute) {
      throw err;
    }

    logger.warn('[PayloadPayin] Charge with deposit routing failed; retrying without processing_method_id', {
      status,
      settlementBankId,
      message: err.message,
    });

    const fallbackBody = {
      ...transactionPayload,
      attrs: { ...(transactionPayload.attrs || {}) },
    };
    delete fallbackBody.processing_method_id;
    if (fallbackBody.attrs) {
      delete fallbackBody.attrs.propmv_deposit_payment_method_id;
    }

    try {
      return await client.createPaymentTransaction(fallbackBody, {
        idempotencyKey: `${idempotencyKey}_fallback`,
      });
    } catch (retryErr) {
      if (shouldRetryPayloadChargeWithoutCustomerId(retryErr, fallbackBody)) {
        const withoutCustomer = {
          ...fallbackBody,
          attrs: { ...(fallbackBody.attrs || {}) },
        };
        delete withoutCustomer.customer_id;
        logger.warn('[PayloadPayin] Charge retry without customer_id after payment_method_id rejection', {
          status: retryErr?.statusCode,
          message: retryErr.message,
        });
        return client.createPaymentTransaction(withoutCustomer, {
          idempotencyKey: `${idempotencyKey}_fallback_nocust`,
        });
      }
      logger.error('[PayloadPayin] Charge retry without deposit routing failed', {
        status: retryErr?.statusCode,
        message: retryErr.message,
        payloadError: retryErr?.payloadError,
      });
      throw retryErr;
    }
  }

  if (shouldRetryPayloadChargeWithoutCustomerId(err, transactionPayload)) {
    const withoutCustomer = {
      ...transactionPayload,
      attrs: { ...(transactionPayload.attrs || {}) },
    };
    delete withoutCustomer.customer_id;
    logger.warn('[PayloadPayin] Charge retry without customer_id after payment_method_id rejection', {
      status,
      message: err.message,
    });
    return client.createPaymentTransaction(withoutCustomer, {
      idempotencyKey: `${idempotencyKey}_nocust`,
    });
  }
}

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function buildPayinIdempotencyKey({ userId, invoiceId, paymentAttemptId }) {
  const seed = [
    String(userId || ''),
    String(invoiceId || ''),
    String(paymentAttemptId || ''),
  ].join(':');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
}

async function syncPayloadPayinToInvoiceProcessing(payinDoc, { description, skipOwnerPaymentAssert = false } = {}) {
  if (!payinDoc?.invoiceId) {
    return { recorded: false, reason: 'missing_invoice' };
  }

  const normalizedStatus = normalizePayinStatus(payinDoc.status);
  if (
    normalizedStatus === PAYIN_STATUS.FAILED
    || normalizedStatus === PAYIN_STATUS.CANCELED
    || normalizedStatus === PAYIN_STATUS.RETURNED
  ) {
    return { recorded: false, reason: 'terminal_payin_status' };
  }

  const gatewayExternalId = String(
    payinDoc.payinId
    || payinDoc.payinConfigId
    || ''
  ).trim();
  if (!gatewayExternalId && !payinDoc._id) {
    return { recorded: false, reason: 'missing_gateway_ref' };
  }

  try {
    return await ensureGatewayProcessingPaymentRecorded({
      invoiceId: payinDoc.invoiceId,
      amount: payinDoc.invoicePaymentAmount,
      method: invoiceMethodLabel(payinDoc.methodType),
      paidBy: payinDoc.userId,
      recordedBy: payinDoc.userId,
      gatewayTransactionId: payinDoc._id,
      gatewayExternalId,
      note: description || `Payload payin initiated - ${gatewayExternalId}`,
      skipOwnerPaymentAssert,
    });
  } catch (err) {
    logger.error('[PayloadPayin] Failed to sync invoice processing payment', {
      invoiceId: String(payinDoc.invoiceId),
      payinId: payinDoc.payinId,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Backfill Processing state when Payload captured funds but the invoice row was never written.
 */
async function repairInvoiceProcessingFromPayloadPayins(invoiceId) {
  if (!payloadConfig.payload?.enabled) {
    return { refreshed: false, reason: 'payload_disabled' };
  }

  const invoiceOid = toObjectId(invoiceId);
  if (!invoiceOid) return { refreshed: false, reason: 'invalid_invoice' };

  let invoice = await Invoice.findOne({ _id: invoiceOid, isDeleted: { $ne: true } });
  if (!invoice) return { refreshed: false, reason: 'invoice_not_found' };
  await reconcileInvoiceStoredTotals(invoice);
  if (Number(invoice.processingAmount || 0) > 0 && Number(invoice.balanceDue || 0) <= 0) {
    return { refreshed: false, reason: 'fully_in_flight' };
  }

  const payins = await PayloadPayin.find({
    invoiceId: invoiceOid,
    payinId: { $exists: true, $nin: [null, ''] },
    status: {
      $nin: [
        PAYIN_STATUS.FAILED,
        PAYIN_STATUS.CANCELED,
        PAYIN_STATUS.RETURNED,
      ],
    },
    isDeleted: { $ne: true },
  }).sort({ createdAt: -1 }).limit(5);

  let recorded = false;
  for (const payinDoc of payins) {
    const result = await syncPayloadPayinToInvoiceProcessing(payinDoc, {
      description: `Payload payin repair - ${payinDoc.payinId || payinDoc._id}`,
    });
    if (result.recorded) recorded = true;
  }

  const refreshedDoc = await Invoice.findById(invoiceOid);
  if (refreshedDoc) {
    await reconcileInvoiceStoredTotals(refreshedDoc);
  }

  if (!recorded && !refreshedDoc) {
    return { refreshed: false, reason: 'no_payins_to_sync' };
  }

  return {
    refreshed: recorded || Boolean(refreshedDoc),
    invoice: refreshedDoc
      ? (typeof refreshedDoc.toObject === 'function' ? refreshedDoc.toObject() : refreshedDoc)
      : null,
  };
}

/**
 * Remove in-flight invoice rows when Payload pay-ins failed (e.g. client timeout + retry, or declined charge).
 */
async function repairStaleProcessingFromFailedPayloadPayins(invoiceId) {
  if (!payloadConfig.payload?.enabled) {
    return { repaired: false, reason: 'payload_disabled' };
  }

  const invoiceOid = toObjectId(invoiceId);
  if (!invoiceOid) return { repaired: false, reason: 'invalid_invoice' };

  const failedPayins = await PayloadPayin.find({
    invoiceId: invoiceOid,
    status: {
      $in: [
        PAYIN_STATUS.FAILED,
        PAYIN_STATUS.CANCELED,
        PAYIN_STATUS.RETURNED,
      ],
    },
    isDeleted: { $ne: true },
  })
    .select('_id payinId status')
    .lean();

  if (!failedPayins.length) {
    return { repaired: false, reason: 'no_failed_payins' };
  }

  let repaired = false;
  for (const payin of failedPayins) {
    const result = await failInvoiceGatewayPayment({
      payinId: payin.payinId || '',
      invoiceId: invoiceOid,
      gatewayTransactionId: payin._id,
    });
    if (result.failed) repaired = true;
  }

  if (!repaired) {
    return { repaired: false, reason: 'no_processing_rows' };
  }

  const invoice = await Invoice.findById(invoiceOid);
  if (invoice) {
    await reconcileInvoiceStoredTotals(invoice);
  }

  return {
    repaired: true,
    invoice: invoice
      ? (typeof invoice.toObject === 'function' ? invoice.toObject() : invoice)
      : null,
  };
}

function buildBillingContact(user = {}) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
    || user.fullName
    || user.name
    || user.email
    || 'HOA Owner';
  const postalCode = String(
    user.address?.zipCode
    || user.address?.postalCode
    || user.zipCode
    || user.postalCode
    || ''
  ).trim();

  return {
    name,
    email: user.email || undefined,
    phone: user.phone || user.mobile || undefined,
    postal_code: postalCode || undefined,
    country: 'US',
  };
}

function sanitizePayin(row) {
  if (!row) return null;
  const doc = typeof row.toObject === 'function' ? row.toObject() : row;
  return {
    id: String(doc._id),
    payinId: doc.payinId || null,
    payinConfigId: doc.payinConfigId,
    merchantId: doc.merchantId,
    invoiceId: doc.invoiceId ? String(doc.invoiceId) : null,
    methodType: doc.methodType,
    status: doc.status,
    invoicePaymentAmount: roundMoney(doc.invoicePaymentAmount),
    chargeAmount: minorUnitsToDollars(doc.chargeAmountCents),
    chargeAmountCents: doc.chargeAmountCents,
    processingFeeAmount: roundMoney(doc.processingFeeAmount || 0),
    processingFeePaidBy: doc.processingFeePaidBy || '',
    platformFeeCents: doc.platformFeeCents || 0,
    currency: doc.currency || 'USD',
    paymentAttemptId: doc.paymentAttemptId || '',
    refusalCode: doc.refusalCode || '',
    refusalDesc: doc.refusalDesc || '',
    settledAt: doc.settledAt || null,
    failedAt: doc.failedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function syncPayinRecordFromRemote(doc, remote = {}, { eventType = '' } = {}) {
  if (!doc) return null;
  const mapped = require('../utils/payloadPayinSettlement.util').mapPayloadTransactionToPayinFields(remote);
  doc.payinId = mapped.payinId || remote.payin_id || remote.payinId || doc.payinId;

  let nextStatus = mapped.status || normalizePayinStatus(remote.status || doc.status);
  const evt = String(eventType || '').trim().toLowerCase().replace('payin.', '');
  const alreadySettled = !!(doc.settledAt || normalizePayinStatus(doc.status) === PAYIN_STATUS.SUCCEEDED);
  if (
    alreadySettled
    && (
      nextStatus === PAYIN_STATUS.FAILED
      || mapped.hasAchReturn
      || evt === 'reject'
      || evt === 'refund'
    )
  ) {
    nextStatus = PAYIN_STATUS.RETURNED;
  }

  // Check21: processed + deferred funding → keep PROCESSING until settle predicate fires.
  const { isCheck21MethodType } = require('../utils/payloadPaymentMethodType.util');
  const { CHECK21_DEFERRED_FUNDING } = require('../utils/payloadPayinSettlement.util');
  if (
    isCheck21MethodType(doc.methodType)
    && !doc.settledAt
    && nextStatus === PAYIN_STATUS.SUCCEEDED
    && CHECK21_DEFERRED_FUNDING.has(String(mapped.fundingStatus || '').toLowerCase())
  ) {
    nextStatus = PAYIN_STATUS.PROCESSING;
  }

  const { applyPayinStatusTransition } = require('../utils/payloadPayinTransition.util');
  const transition = applyPayinStatusTransition(doc.status, nextStatus);
  if (transition.applied) {
    doc.status = transition.status;
  } else if (transition.reason === 'forbidden_transition') {
    // Keep current status; still refresh refusal / lifecycle for ops visibility.
  }

  const resolvedMethodType = resolveRemotePaymentMethodType(remote);
  if (resolvedMethodType) {
    doc.methodType = resolvedMethodType;
  } else {
    const fallback = normalizeMethodType(remote.method_type || remote.methodType);
    if (fallback) doc.methodType = fallback;
  }
  doc.refusalCode = mapped.refusalCode || remote.refusal_code || doc.refusalCode || '';
  doc.refusalDesc = mapped.refusalDesc || remote.refusal_desc || doc.refusalDesc || '';
  doc.raw = remote;
  doc.lastWebhookAt = ClockService.now();
  doc.metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  if (mapped.fundingStatus) {
    doc.metadata.fundingStatus = mapped.fundingStatus;
  }

  const { appendPayloadPayinLifecycleFromRemote } = require('../utils/payloadPayinLifecycle.util');
  doc.metadata.payloadLifecycleHistory = appendPayloadPayinLifecycleFromRemote(
    doc.metadata.payloadLifecycleHistory,
    {
      remote,
      eventType,
      methodType: doc.methodType,
      payinStatus: doc.status,
      at: doc.lastWebhookAt,
    },
  );
  doc.markModified('metadata');

  await doc.save();
  return doc;
}

async function applyPayloadPayinLifecycle({
  payinDoc,
  remotePayload = {},
  eventType = '',
  completedAt,
}) {
  if (!payinDoc) return { action: 'none', reason: 'missing_payin' };

  await syncPayinRecordFromRemote(payinDoc, remotePayload, { eventType });

  const normalizedStatus = normalizePayinStatus(payinDoc.status);
  if (normalizedStatus === PAYIN_STATUS.IN_REVIEW) {
    auditPayload({
      event: AUDIT_EVENTS.PAYIN_IN_REVIEW,
      entity: 'PayloadPayin',
      entityId: payinDoc._id,
      after: {
        payinId: payinDoc.payinId,
        invoiceId: String(payinDoc.invoiceId),
        eventType,
      },
    });
    logger.warn('[PayloadPayin] Payin requires manual review', {
      payinId: payinDoc.payinId,
      invoiceId: String(payinDoc.invoiceId),
      eventType,
    });
  }

  if (
    normalizedStatus === PAYIN_STATUS.RETURNED
    || remotePayload?.has_ach_return
  ) {
    auditPayload({
      event: AUDIT_EVENTS.PAYIN_RETURNED,
      entity: 'PayloadPayin',
      entityId: payinDoc._id,
      success: false,
      failureReason: payinDoc.refusalDesc || 'ACH return or chargeback',
      after: {
        payinId: payinDoc.payinId,
        invoiceId: String(payinDoc.invoiceId),
        eventType,
        hasAchReturn: !!remotePayload?.has_ach_return,
      },
    });
    logger.warn('[PayloadPayin] Payin returned or charged back', {
      payinId: payinDoc.payinId,
      invoiceId: String(payinDoc.invoiceId),
      eventType,
      hasAchReturn: !!remotePayload?.has_ach_return,
    });
  }

  const fundingStatus = String(
    remotePayload?.funding_status
    || remotePayload?.fundingStatus
    || payinDoc.metadata?.fundingStatus
    || '',
  ).toLowerCase();
  const alreadySettled = !!(
    payinDoc.settledAt
    || normalizePayinStatus(payinDoc.status) === PAYIN_STATUS.SUCCEEDED
  );

  const settlementAction = resolvePayloadPayinSettlementAction({
    methodType: payinDoc.methodType,
    status: payinDoc.status,
    eventType,
    hasAchReturn: !!remotePayload?.has_ach_return || fundingStatus === 'reversed',
    fundingStatus,
    alreadySettled: !!(payinDoc.settledAt),
  });

  if (settlementAction === 'settle' && payinDoc.metadata?.trigger === 'automatic') {
    const { assertAutopaySettlementAmountAllowed } = require('../utils/payloadMirrorSafety.util');
    const invoiceForGuard = await Invoice.findOne({
      _id: payinDoc.invoiceId,
      isDeleted: { $ne: true },
    });
    if (invoiceForGuard) {
      await reconcileInvoiceStoredTotals(invoiceForGuard);
      const guard = assertAutopaySettlementAmountAllowed({
        invoice: invoiceForGuard,
        invoicePaymentAmount: payinDoc.invoicePaymentAmount,
      });
      if (!guard.allowed) {
        logger.error('[PayloadPayin] Autopay settlement blocked — amount exceeds balance', {
          payinId: payinDoc.payinId,
          invoiceId: String(payinDoc.invoiceId),
          reason: guard.reason,
          balanceDue: guard.balanceDue,
          txnPrincipal: guard.txnPrincipal,
        });
        return { action: 'none', reason: guard.reason || 'autopay_settlement_blocked' };
      }
    }
  }

  if (settlementAction === 'settle') {
    const { isCheck21MethodType } = require('../utils/payloadPaymentMethodType.util');
    if (isCheck21MethodType(payinDoc.methodType)) {
      const {
        getInvoiceCollectableBalance,
      } = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoicePaymentTransactions.helper');
      const invoiceForCollectable = await Invoice.findOne({
        _id: payinDoc.invoiceId,
        isDeleted: { $ne: true },
      });
      if (invoiceForCollectable) {
        await reconcileInvoiceStoredTotals(invoiceForCollectable);
        const collectable = roundMoney(getInvoiceCollectableBalance(invoiceForCollectable));
        const amount = roundMoney(payinDoc.invoicePaymentAmount);
        // At settle time the processing row already holds this amount in processingAmount;
        // collectable excludes processing — allow settle when amount fits open+this processing.
        const processingSelf = roundMoney(
          (invoiceForCollectable.paymentTransactions || [])
            .filter((tx) => {
              if (!tx || tx.isDeleted) return false;
              if (String(tx.status || '').toLowerCase() !== 'processing') return false;
              return String(tx.gatewayTransactionId || '') === String(payinDoc._id)
                || String(tx.gatewayExternalId || '') === String(payinDoc.payinId || '');
            })
            .reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
        );
        const available = roundMoney(collectable + processingSelf);
        if (amount > available + 0.009) {
          logger.error('[PayloadPayin] Check21 settlement blocked — collectable invariant', {
            payinId: payinDoc.payinId,
            invoiceId: String(payinDoc.invoiceId),
            amount,
            collectable,
            processingSelf,
            available,
          });
          return { action: 'none', reason: 'check21_collectable_invariant' };
        }
      }
    }

    const result = await settleInvoiceGatewayPayment({
      payinId: payinDoc.payinId,
      status: 'settled',
      invoiceId: payinDoc.invoiceId,
      gatewayTransactionId: payinDoc._id,
      completedAt,
    });

    if (result.settled) {
      payinDoc.settledAt = completedAt ? new Date(completedAt) : ClockService.now();
      payinDoc.status = PAYIN_STATUS.SUCCEEDED;
      await payinDoc.save();
      auditPayload({
        event: AUDIT_EVENTS.PAYIN_SETTLED,
        entity: 'PayloadPayin',
        entityId: payinDoc._id,
        after: {
          payinId: payinDoc.payinId,
          invoiceId: String(payinDoc.invoiceId),
          amount: payinDoc.invoicePaymentAmount,
        },
      });
      if (payinDoc.metadata?.trigger === 'automatic') {
        try {
          const { closePayloadMirrorInvoice } = require('./payloadInvoiceSync.service');
          const settledInvoice = await Invoice.findOne({
            _id: payinDoc.invoiceId,
            isDeleted: { $ne: true },
          });
          if (settledInvoice) {
            await closePayloadMirrorInvoice(settledInvoice, { reason: 'autopay_paid' });
          }
        } catch (mirrorErr) {
          logger.warn('[PayloadPayin] Failed to close mirror invoice after autopay settle', {
            invoiceId: String(payinDoc.invoiceId),
            message: mirrorErr.message,
          });
        }
      }
    }

    return { action: 'settle', result };
  }

  if (settlementAction === 'reverse') {
    const { reverseInvoiceGatewayPayment } = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
    const rejectId = String(
      remotePayload?.id
      || remotePayload?.reject_id
      || remotePayload?.refund_id
      || payinDoc.payinId
      || '',
    );
    const result = await reverseInvoiceGatewayPayment({
      payinId: payinDoc.payinId,
      refundId: rejectId ? `reject:${rejectId}` : undefined,
      invoiceId: payinDoc.invoiceId,
      gatewayTransactionId: payinDoc._id,
      refundAmount: payinDoc.invoicePaymentAmount,
      refundedAt: completedAt,
      recordedBy: payinDoc.userId,
      note: rejectId
        ? `Payload Check21/ACH reject (${rejectId})`
        : 'Payload payment rejected after settlement',
    });
    payinDoc.status = PAYIN_STATUS.RETURNED;
    payinDoc.failedAt = completedAt ? new Date(completedAt) : ClockService.now();
    await payinDoc.save();
    auditPayload({
      event: AUDIT_EVENTS.PAYIN_RETURNED,
      entity: 'PayloadPayin',
      entityId: payinDoc._id,
      success: false,
      failureReason: payinDoc.refusalDesc || 'Post-settlement return',
      after: {
        payinId: payinDoc.payinId,
        invoiceId: String(payinDoc.invoiceId),
        reversed: !!result.reversed,
      },
    });
    return { action: 'reverse', result };
  }

  if (settlementAction === 'fail') {
    const result = await failInvoiceGatewayPayment({
      payinId: payinDoc.payinId,
      invoiceId: payinDoc.invoiceId,
      gatewayTransactionId: payinDoc._id,
      failedAt: completedAt,
    });

    payinDoc.failedAt = completedAt ? new Date(completedAt) : ClockService.now();
    await payinDoc.save();

    auditPayload({
      event: AUDIT_EVENTS.PAYIN_FAILED,
      entity: 'PayloadPayin',
      entityId: payinDoc._id,
      success: false,
      failureReason: payinDoc.refusalDesc || payinDoc.status,
      after: {
        payinId: payinDoc.payinId,
        invoiceId: String(payinDoc.invoiceId),
        status: payinDoc.status,
      },
    });

    return { action: 'fail', result };
  }

  auditPayload({
    event: AUDIT_EVENTS.PAYIN_STATUS_UPDATED,
    entity: 'PayloadPayin',
    entityId: payinDoc._id,
    after: {
      payinId: payinDoc.payinId,
      status: payinDoc.status,
      eventType,
    },
  });

  return { action: 'none', status: payinDoc.status };
}

async function executeInvoicePayin({
  userId,
  invoiceId,
  invoicePaymentAmount,
  chargeAmount,
  paymentMethodId,
  paymentAttemptId,
  description,
  skipPayerFeeAutofill = false,
  coveredInvoiceIds = [],
  req = null,
}) {
  ensurePayloadEnabled();

  const userOid = toObjectId(userId);
  const invoiceOid = toObjectId(invoiceId);
  if (!userOid || !invoiceOid) {
    const err = new Error('Invalid payin request.');
    err.statusCode = 400;
    throw err;
  }

  const netAmount = roundMoney(invoicePaymentAmount);
  const totalChargeInput = roundMoney(chargeAmount != null ? chargeAmount : invoicePaymentAmount);
  if (netAmount <= 0 || totalChargeInput <= 0) {
    const err = new Error('Payment amount must be greater than zero.');
    err.statusCode = 400;
    throw err;
  }

  const invoice = await Invoice.findOne({ _id: invoiceOid, isDeleted: { $ne: true } });
  if (!invoice) {
    const err = new Error('Invoice not found.');
    err.statusCode = 404;
    throw err;
  }
  await reconcileInvoiceStoredTotals(invoice);

  const Property = require('../../../../../../portals/hoa-board/modules/property/model/property.model');
  let propertyHoaIdForContext = null;
  if (invoice.propertyId) {
    const propertyRow = await Property.findById(invoice.propertyId).select('hoaId').lean();
    propertyHoaIdForContext = propertyRow?.hoaId ? String(propertyRow.hoaId) : null;
  }

  let payinContext = await resolvePayinMerchantContext({
    invoice,
    paymentMethodRef: paymentMethodId,
    userId: userOid,
  });
  let { method, account, merchantId, depositMethod } = payinContext;

  if (
    propertyHoaIdForContext
    && payloadConfig.payload.hoaUnifiedOwnerWallet
  ) {
    const {
      findOwnerPaymentMethodGroupForUser,
    } = require('./payloadPaymentMethod.service');
    const { ENTITY_TYPE } = require('../constants/payload.constants');
    try {
      const { doc: canonical } = await findOwnerPaymentMethodGroupForUser({
        userId: userOid,
        localMethodId: method._id,
        entityType: ENTITY_TYPE.HOA,
        entityId: propertyHoaIdForContext,
      });
      if (canonical) method = canonical;
    } catch (canonicalErr) {
      logger.warn('[PayloadPayin] Canonical HOA payment method lookup failed; using selected row', {
        localMethodId: String(method._id || ''),
        message: canonicalErr.message,
      });
    }
  }

  const [user, billingSettings] = await Promise.all([
    User.findById(userOid)
      .select('firstName lastName email phone mobile address zipCode postalCode')
      .lean(),
    getEffectiveBillingSettingsForProperty(invoice.propertyId),
  ]);
  const {
    totalCharge,
    validation: amountValidation,
  } = resolveAuthoritativePayloadPayinAmounts({
    invoicePaymentAmount: netAmount,
    chargeAmount: totalChargeInput,
    methodType: method.type,
    billingSettings,
    skipPayerFeeAutofill: Boolean(skipPayerFeeAutofill),
  });

  if (!amountValidation.valid) {
    const err = new Error(
      amountValidation.reason === 'missing_payer_fee'
        ? 'Processing fee is required for this payment method.'
        : 'Payment amount does not match the configured processing fee.'
    );
    err.statusCode = 400;
    err.details = {
      expectedChargeAmount: amountValidation.expectedChargeAmount,
      processingFeeAmount: amountValidation.processingFeeAmount,
      processingFeePaidBy: amountValidation.processingFeePaidBy,
    };
    throw err;
  }

  if (totalCharge + 0.0001 < netAmount) {
    const err = new Error('Charge amount cannot be less than the invoice payment amount.');
    err.statusCode = 400;
    throw err;
  }

  try {
    await ledgerService.assertOwnerOnlinePaymentAllowed(invoice, netAmount, null, {
      coveredInvoiceIds: Array.isArray(coveredInvoiceIds) ? coveredInvoiceIds : [],
    });
  } catch (validationErr) {
    const err = new Error(validationErr.message || 'Payment validation failed');
    err.statusCode = validationErr.status || validationErr.statusCode || 400;
    throw err;
  }

  const attemptKey = String(paymentAttemptId || ClockService.nowEpoch());
  const idempotencyKey = buildPayinIdempotencyKey({
    userId: userOid,
    invoiceId: invoiceOid,
    paymentAttemptId: attemptKey,
  });

  const existing = await PayloadPayin.findOne({
    idempotencyKey,
    isDeleted: { $ne: true },
  });
  if (existing?.payinId) {
    await syncPayloadPayinToInvoiceProcessing(existing, { description }).catch((err) => {
      if (err.statusCode !== 409) {
        logger.warn('[PayloadPayin] Duplicate payin invoice sync failed', {
          invoiceId: String(invoiceOid),
          payinId: existing.payinId,
          message: err.message,
        });
      }
    });
    return {
      duplicate: true,
      item: sanitizePayin(existing),
    };
  }

  const chargeAmountCents = dollarsToMinorUnits(totalCharge);
  const metadata = {
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceId || '',
    invoicePaymentAmount: String(netAmount),
    processingFeeAmount: String(amountValidation.processingFeeAmount || 0),
    processingFeePaidBy: amountValidation.processingFeePaidBy || '',
    paymentAttemptId: attemptKey,
    propmv_user_id: String(userOid),
    propmv_property_id: invoice.propertyId ? String(invoice.propertyId) : '',
  };

  const propertyHoaId = propertyHoaIdForContext;

  const {
    resolvePayloadUserRecordForPayin,
  } = require('./payloadPaymentMethod.service');
  let payloadUser = await resolvePayloadUserRecordForPayin({
    userId: userOid,
    method,
    hoaId: propertyHoaId,
  });
  const customerMerchantScope = payloadUser?.billableMerchantId
    ? String(payloadUser.billableMerchantId)
    : String(method.billableMerchantId || merchantId);
  let localCustomerId = payloadUser?.metadata?.payloadCustomerId
    || method.metadata?.payloadCustomerId
    || null;

  const settlementBankId = resolvePayloadSettlementBankIdForMerchant(depositMethod, merchantId);

  const providerPaymentMethodId = String(method.providerPaymentMethodId || '').trim();
  if (!providerPaymentMethodId) {
    const err = new Error('Payload payment method is missing provider id. Re-add your payment method.');
    err.statusCode = 400;
    throw err;
  }

  let remotePaymentMethod = null;
  try {
    remotePaymentMethod = await client.getPaymentMethod(providerPaymentMethodId);
    validateRemotePaymentMethodForCharge(remotePaymentMethod);
  } catch (pmErr) {
    if (pmErr.statusCode === 400 || pmErr.statusCode === 403 || pmErr.statusCode === 404) {
      throw pmErr;
    }
    const err = new Error('Payload could not verify this saved payment method. Re-add it in Settings or choose another method.');
    err.statusCode = 400;
    throw err;
  }

  const remoteCustomerId = String(
    remotePaymentMethod?.customer_id
    || remotePaymentMethod?.customerId
    || '',
  ).trim();
  if (remoteCustomerId) {
    localCustomerId = remoteCustomerId;
    method.metadata = {
      ...(method.metadata || {}),
      payloadCustomerId: remoteCustomerId,
    };
    method.markModified?.('metadata');
    method.lastWebhookAt = ClockService.now();
    await method.save?.();
  }

  const paymentMethodScope = classifyPayloadPaymentMethodScope(remotePaymentMethod);
  let customerId = '';
  if (paymentMethodScope === 'customer') {
    customerId = resolvePayloadChargeCustomerId({
      localCustomerId,
      remotePaymentMethod: remotePaymentMethod || {},
      processingAccountId: merchantId,
    });
  }

  if (paymentMethodScope === 'customer' && !customerId) {
    const {
      ensurePayloadUserContext,
      ensurePayloadCustomerForUser,
    } = require('./payloadPaymentMethod.service');
    const { resolveHoaOwnerPayloadCustomerContext } = require('../utils/payloadHoaOwnerCustomerContext.util');
    const { findActiveBillableMerchantId } = require('../utils/payloadBillableMerchant.util');
    const hoaPayinContext = propertyHoaId
      ? await resolveHoaOwnerPayloadCustomerContext(propertyHoaId, {
        findActiveBillableMerchantId,
        ownerUserId: userOid,
      })
      : null;

    payloadUser = payloadUser || await ensurePayloadUserContext({
      userId: userOid,
      billableMerchantId: customerMerchantScope,
      entityType: propertyHoaId ? require('../constants/payload.constants').ENTITY_TYPE.HOA : null,
      entityId: propertyHoaId || invoice.propertyId || null,
    });
    const { resolvePayloadPrimaryProcessingIdForOwnerWallet } = require('../utils/payloadHoaOwnerProcessingAccount.util');
    const payinPrimaryProcessingId = hoaPayinContext
      ? resolvePayloadPrimaryProcessingIdForOwnerWallet({
        primaryProcessingId: hoaPayinContext.primaryProcessingId,
        merchantIds: hoaPayinContext.merchantIds,
      }) || merchantId
      : merchantId;
    localCustomerId = await ensurePayloadCustomerForUser({
      userId: userOid,
      billableMerchantId: customerMerchantScope,
      primaryProcessingId: payinPrimaryProcessingId,
      hoaMerchantIds: hoaPayinContext?.merchantIds || [],
      hoaId: propertyHoaId,
      user,
      payloadUserRecord: payloadUser,
    });
    customerId = resolvePayloadChargeCustomerId({
      localCustomerId,
      remotePaymentMethod: remotePaymentMethod || {},
      processingAccountId: merchantId,
    });
  }

  if (customerId && payloadUser && payloadUser.metadata?.payloadCustomerId !== customerId) {
    payloadUser.metadata = {
      ...(payloadUser.metadata || {}),
      payloadCustomerId: customerId,
    };
    payloadUser.markModified('metadata');
    payloadUser.lastSyncedAt = ClockService.now();
    await payloadUser.save();
  }

  if (paymentMethodScope === 'customer' && !customerId) {
    const err = new Error('Payload customer profile is missing. Re-add your payment method.');
    err.statusCode = 400;
    throw err;
  }

  const clientIp = String(
    req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req?.ip
    || req?.connection?.remoteAddress
    || ''
  ).trim();

  // https://docs.payload.com/apis/payments/charging-a-customer/
  const transactionPayload = buildPayloadTransactionChargeBody({
    netAmount,
    totalCharge,
    amountValidation,
    customerId,
    paymentMethodId: providerPaymentMethodId,
    merchantId,
    settlementBankId,
    description: description || `Invoice ${invoice.invoiceId || invoice._id}`,
    metadata,
    clientIp,
  });

  const payinConfigId = `${idempotencyKey}_txn`;
  const chargedMethodType = resolveRemotePaymentMethodType(remotePaymentMethod)
    || normalizeMethodType(method.type)
    || String(method.type || '').trim();

  let payinDoc = existing;
  if (!payinDoc) {
    payinDoc = await PayloadPayin.create({
      payinConfigId,
      merchantId,
      payloadAccountRef: account?._id || null,
      invoiceId: invoice._id,
      propertyId: invoice.propertyId || null,
      userId: userOid,
      paymentMethodLocalId: method._id,
      providerPaymentMethodId: method.providerPaymentMethodId,
      methodType: chargedMethodType,
      status: PAYIN_STATUS.CREATED,
      invoicePaymentAmount: netAmount,
      chargeAmountCents,
      processingFeeAmount: amountValidation.processingFeeAmount || 0,
      processingFeePaidBy: amountValidation.processingFeePaidBy || '',
      platformFeeCents: amountValidation.convFeeCents || 0,
      currency: 'USD',
      paymentAttemptId: attemptKey,
      idempotencyKey,
      metadata,
    });
  } else if (chargedMethodType && payinDoc.methodType !== chargedMethodType) {
    payinDoc.methodType = chargedMethodType;
    await payinDoc.save();
  }

  let remotePayin;
  try {
    remotePayin = await createPayloadPaymentTransactionWithFallback({
      transactionPayload,
      idempotencyKey: `${idempotencyKey}_payin`,
      settlementBankId,
    });
  } catch (err) {
    payinDoc.status = PAYIN_STATUS.FAILED;
    payinDoc.refusalDesc = err.message || 'Payload payment failed.';
    payinDoc.failedAt = ClockService.now();
    await payinDoc.save();
    try {
      await failInvoiceGatewayPayment({
        payinId: payinDoc.payinId || '',
        invoiceId: payinDoc.invoiceId,
        gatewayTransactionId: payinDoc._id,
      });
    } catch (cleanupErr) {
      logger.warn('[PayloadPayin] Failed to clear invoice processing row after charge failure', {
        invoiceId: String(payinDoc.invoiceId),
        message: cleanupErr.message,
      });
    }
    logger.error('[PayloadPayin] createPaymentTransaction failed', {
      invoiceId: String(invoice._id),
      status: err?.statusCode,
      message: err.message,
      payloadError: err?.payloadError,
    });
    throw err;
  }

  await syncPayinRecordFromRemote(payinDoc, remotePayin, { eventType: 'payment' });

  auditPayload({
    event: AUDIT_EVENTS.PAYIN_CREATED,
    entity: 'PayloadPayin',
    entityId: payinDoc._id,
    createdBy: userOid,
    after: {
      payinId: payinDoc.payinId,
      payinConfigId,
      merchantId,
      invoiceId: String(invoice._id),
      status: payinDoc.status,
    },
    req,
  });

  const normalizedStatus = normalizePayinStatus(payinDoc.status);
  if (normalizedStatus === PAYIN_STATUS.FAILED) {
    const err = new Error(payinDoc.refusalDesc || 'Payload declined this payment.');
    err.statusCode = 402;
    err.details = {
      payinId: payinDoc.payinId,
      refusalCode: payinDoc.refusalCode,
      refusalDesc: payinDoc.refusalDesc,
    };
    throw err;
  }

  if (normalizedStatus !== PAYIN_STATUS.FAILED) {
    try {
      await syncPayloadPayinToInvoiceProcessing(payinDoc, {
        description,
        skipOwnerPaymentAssert: true,
      });
    } catch (invoiceErr) {
      if (invoiceErr.statusCode === 409 || invoiceErr.statusCode === 400) {
        const err = new Error(invoiceErr.message);
        err.statusCode = invoiceErr.statusCode;
        throw err;
      }
    }
  }

  const lifecycleEventType = normalizedStatus === PAYIN_STATUS.PROCESSING ? 'payin.processing' : '';
  const lifecycleAction = resolvePayloadPayinSettlementAction({
    methodType: payinDoc.methodType,
    status: payinDoc.status,
    eventType: lifecycleEventType,
    hasAchReturn: !!remotePayin?.has_ach_return,
  });

  // Bank/ACH: stay Processing until Payload webhooks confirm funds (never settle on execute).
  const allowExecuteSettle =
    lifecycleAction === 'settle'
    && isCardLikeMethodType(payinDoc.methodType)
    && !isAchLikeMethodType(payinDoc.methodType);

  if (allowExecuteSettle) {
    setImmediate(() => {
      applyPayloadPayinLifecycle({
        payinDoc,
        remotePayload: remotePayin,
        eventType: lifecycleEventType,
      }).catch((lifecycleErr) => {
        logger.error('[PayloadPayin] Deferred lifecycle failed', {
          payinId: payinDoc.payinId,
          invoiceId: String(payinDoc.invoiceId),
          action: lifecycleAction,
          message: lifecycleErr.message,
        });
      });
    });

    return {
      duplicate: false,
      item: sanitizePayin(payinDoc),
      lifecycle: { action: lifecycleAction, deferred: true },
    };
  }

  // Bank/ACH: invoice stays Processing until Payload webhooks call applyPayloadPayinLifecycle.
  if (isAchLikeMethodType(payinDoc.methodType)) {
    if (lifecycleAction === 'fail') {
      const lifecycle = await applyPayloadPayinLifecycle({
        payinDoc,
        remotePayload: remotePayin,
        eventType: lifecycleEventType,
      });
      return {
        duplicate: false,
        item: sanitizePayin(payinDoc),
        lifecycle,
      };
    }

    if (lifecycleAction === 'settle') {
      logger.info('[PayloadPayin] ACH settle skipped on execute; awaiting Payload webhook', {
        payinId: payinDoc.payinId,
        invoiceId: String(payinDoc.invoiceId),
        status: payinDoc.status,
        methodType: payinDoc.methodType,
      });
    }

    return {
      duplicate: false,
      item: sanitizePayin(payinDoc),
      lifecycle: {
        action: 'none',
        deferred: true,
        reason: 'ach_await_webhook',
      },
    };
  }

  const lifecycle = await applyPayloadPayinLifecycle({
    payinDoc,
    remotePayload: remotePayin,
    eventType: lifecycleEventType,
  });

  return {
    duplicate: false,
    item: sanitizePayin(payinDoc),
    lifecycle,
  };
}

async function getPayinForUser({ userId, payinRef }) {
  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  const ref = String(payinRef || '').trim();
  let doc = null;
  if (mongoose.Types.ObjectId.isValid(ref) && ref.length === 24) {
    doc = await PayloadPayin.findOne({ _id: ref, userId: userOid, isDeleted: { $ne: true } });
  }
  if (!doc) {
    doc = await PayloadPayin.findOne({ payinId: ref, userId: userOid, isDeleted: { $ne: true } });
  }
  if (!doc) {
    const err = new Error('Payload payin not found.');
    err.statusCode = 404;
    throw err;
  }

  if (doc.payinId) {
    try {
      const remote = await client.getTransaction(doc.payinId);
      await syncPayinRecordFromRemote(doc, remote);
    } catch (err) {
      logger.warn('[PayloadPayin] Remote refresh failed', {
        payinId: doc.payinId,
        message: err.message,
      });
    }
  }

  return sanitizePayin(doc);
}

function mergeRemoteAttrs(remote = {}) {
  const attrs = remote?.attrs && typeof remote.attrs === 'object' ? remote.attrs : {};
  const metadata = remote?.metadata && typeof remote.metadata === 'object' ? remote.metadata : {};
  return { ...metadata, ...attrs };
}

async function resolvePropmvInvoiceFromAutomaticPayment(remote = {}) {
  const attrs = mergeRemoteAttrs(remote);
  const candidates = [
    attrs.propmvInvoiceId,
    attrs.invoiceId,
    attrs.invoice_id,
    remote.external_uid,
    remote.externalUid,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const id of candidates) {
    if (!mongoose.Types.ObjectId.isValid(id) || id.length !== 24) continue;
    const invoice = await Invoice.findOne({ _id: id, isDeleted: { $ne: true } });
    if (invoice) return invoice;
  }

  const payloadInvoiceId = String(
    remote.invoice_id
    || remote.invoiceId
    || attrs.payloadInvoiceId
    || '',
  ).trim();
  if (payloadInvoiceId) {
    const invoice = await Invoice.findOne({
      'payloadAutopayMirror.payloadInvoiceId': payloadInvoiceId,
      isDeleted: { $ne: true },
    });
    if (invoice) return invoice;
  }

  return null;
}

async function ensurePayinFromAutomaticPaymentWebhook({ payinId, remotePayload = {}, eventType = '' }) {
  const transactionId = String(payinId || remotePayload?.id || '').trim();
  if (!transactionId) return null;

  let doc = await PayloadPayin.findOne({ payinId: transactionId, isDeleted: { $ne: true } });
  if (doc) return doc;

  const normalizedEvent = String(eventType || '').trim().toLowerCase();
  const trigger = String(remotePayload?.trigger || remotePayload?.payment_trigger || '').trim().toLowerCase();
  if (normalizedEvent !== 'automatic_payment' && trigger !== 'automatic') {
    return null;
  }

  const invoice = await resolvePropmvInvoiceFromAutomaticPayment(remotePayload);
  if (!invoice) return null;

  const attrs = mergeRemoteAttrs(remotePayload);
  const userIdStr = String(attrs.propmvUserId || attrs.userId || '').trim();
  let userOid = toObjectId(userIdStr);
  if (!userOid && Array.isArray(invoice.tenants) && invoice.tenants.length === 1) {
    userOid = toObjectId(invoice.tenants[0].userId || invoice.tenants[0]._id);
  }
  if (!userOid) return null;

  const providerPaymentMethodId = String(
    remotePayload.payment_method_id
    || remotePayload.paymentMethodId
    || attrs.paymentMethodId
    || '',
  ).trim();
  if (!providerPaymentMethodId) return null;

  const paymentMethod = await require('../model/payloadPaymentMethod.model').findOne({
    userId: userOid,
    providerPaymentMethodId,
    isDeleted: { $ne: true },
  }).sort({ createdAt: -1 });

  const methodType = resolveRemotePaymentMethodType(remotePayload)
    || normalizeMethodType(paymentMethod?.type)
    || 'CARD';

  const chargeDollars = roundMoney(
    remotePayload.amount != null
      ? remotePayload.amount
      : minorUnitsToDollars(remotePayload.amount_cents || remotePayload.amountCents),
  );
  const invoicePaymentAmount = roundMoney(
    attrs.invoicePaymentAmount != null ? attrs.invoicePaymentAmount : chargeDollars,
  );
  const chargeAmountCents = dollarsToMinorUnits(chargeDollars || invoicePaymentAmount);

  const merchantId = String(
    remotePayload.processing_id
    || remotePayload.processingId
    || attrs.merchantId
    || '',
  ).trim();
  if (!merchantId) return null;

  const idempotencyKey = `autopay_txn_${transactionId}`;
  const paymentAttemptId = `automatic:${transactionId}`;

  const existingAttempt = await PayloadPayin.findOne({
    invoiceId: invoice._id,
    paymentAttemptId,
    isDeleted: { $ne: true },
  });
  if (existingAttempt) {
    if (!existingAttempt.payinId) {
      existingAttempt.payinId = transactionId;
      await existingAttempt.save();
    }
    return existingAttempt;
  }

  doc = await PayloadPayin.create({
    payinConfigId: `${idempotencyKey}_cfg`,
    payinId: transactionId,
    merchantId,
    invoiceId: invoice._id,
    propertyId: invoice.propertyId || null,
    userId: userOid,
    paymentMethodLocalId: paymentMethod?._id || null,
    providerPaymentMethodId,
    methodType,
    status: PAYIN_STATUS.CREATED,
    invoicePaymentAmount,
    chargeAmountCents,
    processingFeeAmount: roundMoney(attrs.processingFeeAmount || 0),
    processingFeePaidBy: attrs.processingFeePaidBy || '',
    platformFeeCents: 0,
    currency: 'USD',
    paymentAttemptId,
    idempotencyKey,
    metadata: {
      trigger: 'automatic',
      payloadInvoiceId: invoice.payloadAutopayMirror?.payloadInvoiceId || '',
    },
  });

  await syncPayloadPayinToInvoiceProcessing(doc, {
    description: 'Payload automatic payment initiated',
    skipOwnerPaymentAssert: true,
  });

  auditPayload({
    event: AUDIT_EVENTS.PAYIN_CREATED,
    entity: 'PayloadPayin',
    entityId: doc._id,
    createdBy: userOid,
    after: {
      payinId: doc.payinId,
      invoiceId: String(invoice._id),
      trigger: 'automatic',
    },
  });

  return doc;
}

async function applyPayinWebhookUpdate({ payinId, remotePayload = {}, eventType = '' }) {
  if (!payinId) return { processed: false, reason: 'missing_payin_id' };

  let doc = await PayloadPayin.findOne({ payinId: String(payinId), isDeleted: { $ne: true } });
  if (!doc) {
    doc = await ensurePayinFromAutomaticPaymentWebhook({ payinId, remotePayload, eventType });
  }
  if (!doc) {
    const metadataInvoiceId =
      remotePayload?.attrs?.invoiceId
      || remotePayload?.metadata?.invoiceId
      || remotePayload?.metadata?.invoice_id
      || null;
    if (metadataInvoiceId) {
      doc = await PayloadPayin.findOne({
        invoiceId: metadataInvoiceId,
        payinConfigId: remotePayload?.payin_config_id || remotePayload?.payinConfigId || undefined,
        isDeleted: { $ne: true },
      }).sort({ createdAt: -1 });
      if (doc && !doc.payinId) {
        doc.payinId = String(payinId);
        await doc.save();
      }
    }
  }

  if (!doc) {
    logger.warn('[PayloadPayin] Webhook payin not linked locally', { payinId, eventType });
    return { processed: false, reason: 'payin_not_found' };
  }

  await syncPayloadPayinToInvoiceProcessing(doc).catch((err) => {
    logger.warn('[PayloadPayin] Webhook invoice processing sync failed', {
      payinId: doc.payinId,
      invoiceId: String(doc.invoiceId || ''),
      message: err.message,
    });
  });

  const lifecycle = await applyPayloadPayinLifecycle({
    payinDoc: doc,
    remotePayload,
    eventType,
    completedAt: remotePayload?.updated_at || remotePayload?.updatedAt,
  });

  return { processed: true, lifecycle };
}

async function validatePayinAllocations({
  userId,
  paymentMethodId,
  allocations = [],
}) {
  ensurePayloadEnabled();

  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(allocations) || allocations.length === 0) {
    const err = new Error('At least one invoice allocation is required.');
    err.statusCode = 400;
    throw err;
  }

  const issues = [];
  const merchantContexts = [];
  const { method: paymentMethod } = await assertPaymentMethodForPayin({
    userId: userOid,
    paymentMethodRef: paymentMethodId,
  });
  const methodType = paymentMethod.type;

  // Resolve invoices first, then validate in FIFO order so multi-invoice Pay Total
  // treats earlier legs as covering older balances (and fee applies once on the first leg).
  const resolvedRows = [];
  for (const allocation of allocations) {
    const invoiceOid = toObjectId(allocation?.invoiceId);
    if (!invoiceOid) {
      issues.push({
        invoiceId: allocation?.invoiceId || null,
        code: 'INVALID_INVOICE',
        message: 'Invalid invoice.',
      });
      continue;
    }

    const invoice = await Invoice.findOne({ _id: invoiceOid, isDeleted: { $ne: true } });
    if (!invoice) {
      issues.push({
        invoiceId: String(allocation.invoiceId),
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found.',
      });
      continue;
    }
    await reconcileInvoiceStoredTotals(invoice);
    resolvedRows.push({ allocation, invoice });
  }

  resolvedRows.sort((a, b) => compareInvoicesFifo(a.invoice, b.invoice));

  const batchCoveredBalances = new Map();

  for (let index = 0; index < resolvedRows.length; index += 1) {
    const { allocation, invoice } = resolvedRows[index];

    try {
      const ctx = await resolvePayinMerchantContext({
        invoice,
        paymentMethodRef: paymentMethodId,
        userId: userOid,
      });
      const invoicePaymentAmount = roundMoney(
        allocation?.invoicePaymentAmount != null
          ? allocation.invoicePaymentAmount
          : invoice.balanceDue || invoice.subAmount || 0
      );
      if (invoicePaymentAmount <= 0) {
        issues.push({
          invoiceId: String(invoice._id),
          invoiceNumber: invoice.invoiceId || '',
          code: 'INVALID_AMOUNT',
          message: 'Payment amount must be greater than zero.',
        });
        continue;
      }
      try {
        await ledgerService.assertOwnerOnlinePaymentAllowed(
          invoice,
          invoicePaymentAmount,
          null,
          { batchCoveredBalances }
        );
      } catch (validationErr) {
        issues.push({
          invoiceId: String(invoice._id),
          invoiceNumber: invoice.invoiceId || '',
          code: 'PAYMENT_NOT_ALLOWED',
          message: validationErr.message || 'Payment validation failed.',
        });
        continue;
      }
      const billingSettings = await getEffectiveBillingSettingsForProperty(invoice.propertyId);
      const feeQuote = calculatePayloadProcessingFee({
        invoicePaymentAmount,
        methodType,
        billingSettings,
        applyFee: index === 0,
      });
      merchantContexts.push({
        invoiceId: String(invoice._id),
        invoiceNumber: invoice.invoiceId || '',
        merchantId: ctx.merchantId,
        depositMethodId: ctx.depositMethod?._id ? String(ctx.depositMethod._id) : null,
        invoicePaymentAmount: feeQuote.invoicePaymentAmount,
        processingFeeAmount: feeQuote.processingFeeAmount,
        processingFeePaidBy: feeQuote.processingFeePaidBy,
        chargeAmount: feeQuote.chargeAmount,
        platformFeeCents: feeQuote.platformFeeCents,
      });
      const invoiceKey = String(invoice._id);
      batchCoveredBalances.set(
        invoiceKey,
        roundMoney((batchCoveredBalances.get(invoiceKey) || 0) + invoicePaymentAmount)
      );
    } catch (err) {
      issues.push({
        invoiceId: String(invoice._id),
        invoiceNumber: invoice.invoiceId || '',
        code: 'MERCHANT_RESOLUTION_FAILED',
        message: err.message || 'Unable to route payment for this invoice.',
      });
    }
  }

  issues.push(...detectMultiMerchantPayinIssues(merchantContexts));

  const merchantIds = [...new Set(merchantContexts.map((ctx) => ctx.merchantId).filter(Boolean))];

  return {
    valid: issues.length === 0,
    merchantId: merchantIds.length === 1 ? merchantIds[0] : null,
    merchantCount: merchantIds.length,
    allocations: merchantContexts,
    issues,
  };
}

function compareInvoicesFifo(a, b) {
  const dueA = a?.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
  const dueB = b?.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
  if (dueA !== dueB) return dueA - dueB;
  const createdA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
  const createdB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (createdA !== createdB) return createdA - createdB;
  return String(a?._id || '').localeCompare(String(b?._id || ''));
}

module.exports = {
  executeInvoicePayin,
  getPayinForUser,
  applyPayinWebhookUpdate,
  applyPayloadPayinLifecycle,
  sanitizePayin,
  buildPayinIdempotencyKey,
  validatePayinAllocations,
  repairInvoiceProcessingFromPayloadPayins,
  repairStaleProcessingFromFailedPayloadPayins,
  syncPayloadPayinToInvoiceProcessing,
};
