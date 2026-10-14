'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const RainforestPayin = require('../model/rainforestPayin.model');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const User = require('../../../../users/models/user.model');
const { RainforestClient } = require('../client/rainforest.client');
const {
  settleInvoiceGatewayPayment,
  failInvoiceGatewayPayment,
} = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
const { ensureRainforestEnabled } = require('./rainforestMerchant.service');
const { resolvePayinMerchantContext, assertPaymentMethodForPayin } = require('../utils/resolveRainforestPayinMerchant.util');
const {
  AUDIT_EVENTS,
  PAYIN_STATUS,
} = require('../constants/rainforest.constants');
const {
  roundMoney,
  dollarsToMinorUnits,
  minorUnitsToDollars,
  normalizePayinStatus,
  invoiceMethodLabel,
  resolveRainforestPayinSettlementAction,
} = require('../utils/rainforestPayinSettlement.util');
const { detectMultiMerchantPayinIssues } = require('../utils/rainforestPayinAllocation.util');
const {
  calculateRainforestProcessingFee,
  validateRainforestPayinAmounts,
  resolveAuthoritativeRainforestPayinAmounts,
} = require('../utils/rainforestPayinFee.util');
const {
  getEffectiveBillingSettingsForProperty,
} = require('../../../../billing-settings/service/billingSettings.service');
const { auditRainforest } = require('./rainforestAudit.helper');
const logger = require('../../../../../../common/logger');

const client = new RainforestClient();

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

async function syncPayinRecordFromRemote(doc, remote = {}) {
  if (!doc) return null;
  const status = normalizePayinStatus(remote.status || doc.status);
  doc.payinId = remote.payin_id || remote.payinId || doc.payinId;
  doc.status = status || doc.status;
  doc.methodType = remote.method_type || remote.methodType || doc.methodType;
  doc.refusalCode = remote.refusal_code || remote.refusalCode || doc.refusalCode || '';
  doc.refusalDesc = remote.refusal_desc || remote.refusalDesc || doc.refusalDesc || '';
  doc.raw = remote;
  doc.lastWebhookAt = ClockService.now();
  await doc.save();
  return doc;
}

async function applyRainforestPayinLifecycle({
  payinDoc,
  remotePayload = {},
  eventType = '',
  completedAt,
}) {
  if (!payinDoc) return { action: 'none', reason: 'missing_payin' };

  await syncPayinRecordFromRemote(payinDoc, remotePayload);

  const normalizedStatus = normalizePayinStatus(payinDoc.status);
  if (normalizedStatus === PAYIN_STATUS.IN_REVIEW) {
    auditRainforest({
      event: AUDIT_EVENTS.PAYIN_IN_REVIEW,
      entity: 'RainforestPayin',
      entityId: payinDoc._id,
      after: {
        payinId: payinDoc.payinId,
        invoiceId: String(payinDoc.invoiceId),
        eventType,
      },
    });
    logger.warn('[RainforestPayin] Payin requires manual review', {
      payinId: payinDoc.payinId,
      invoiceId: String(payinDoc.invoiceId),
      eventType,
    });
  }

  if (
    normalizedStatus === PAYIN_STATUS.RETURNED
    || remotePayload?.has_ach_return
  ) {
    auditRainforest({
      event: AUDIT_EVENTS.PAYIN_RETURNED,
      entity: 'RainforestPayin',
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
    logger.warn('[RainforestPayin] Payin returned or charged back', {
      payinId: payinDoc.payinId,
      invoiceId: String(payinDoc.invoiceId),
      eventType,
      hasAchReturn: !!remotePayload?.has_ach_return,
    });
  }

  const settlementAction = resolveRainforestPayinSettlementAction({
    methodType: payinDoc.methodType,
    status: payinDoc.status,
    eventType,
    hasAchReturn: !!remotePayload?.has_ach_return,
  });

  if (settlementAction === 'settle') {
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
      auditRainforest({
        event: AUDIT_EVENTS.PAYIN_SETTLED,
        entity: 'RainforestPayin',
        entityId: payinDoc._id,
        after: {
          payinId: payinDoc.payinId,
          invoiceId: String(payinDoc.invoiceId),
          amount: payinDoc.invoicePaymentAmount,
        },
      });
    }

    return { action: 'settle', result };
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

    auditRainforest({
      event: AUDIT_EVENTS.PAYIN_FAILED,
      entity: 'RainforestPayin',
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

  auditRainforest({
    event: AUDIT_EVENTS.PAYIN_STATUS_UPDATED,
    entity: 'RainforestPayin',
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
  req = null,
}) {
  ensureRainforestEnabled();

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

  const { method, account, merchantId } = await resolvePayinMerchantContext({
    invoice,
    paymentMethodRef: paymentMethodId,
    userId: userOid,
  });

  const billingSettings = await getEffectiveBillingSettingsForProperty(invoice.propertyId);
  const {
    totalCharge,
    validation: amountValidation,
  } = resolveAuthoritativeRainforestPayinAmounts({
    invoicePaymentAmount: netAmount,
    chargeAmount: totalChargeInput,
    methodType: method.type,
    billingSettings,
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

  const attemptKey = String(paymentAttemptId || ClockService.nowEpoch());
  const idempotencyKey = buildPayinIdempotencyKey({
    userId: userOid,
    invoiceId: invoiceOid,
    paymentAttemptId: attemptKey,
  });

  const existing = await RainforestPayin.findOne({
    idempotencyKey,
    isDeleted: { $ne: true },
  });
  if (existing?.payinId) {
    return {
      duplicate: true,
      item: sanitizePayin(existing),
    };
  }

  const user = await User.findById(userOid)
    .select('firstName lastName email phone mobile address zipCode postalCode')
    .lean();

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

  const payinConfigPayload = {
    merchant_id: merchantId,
    idempotency_key: `${idempotencyKey}_cfg`,
    amount: chargeAmountCents,
    currency_code: 'USD',
    billing_contact: buildBillingContact(user || {}),
    metadata,
  };
  if (amountValidation.amountSplits) {
    payinConfigPayload.amount_splits = amountValidation.amountSplits;
  }

  const payinConfig = await client.createPayinConfig(
    payinConfigPayload,
    { idempotencyKey: `${idempotencyKey}_cfg` }
  );

  const payinConfigId =
    payinConfig?.payin_config_id
    || payinConfig?.payinConfigId
    || '';

  if (!payinConfigId) {
    const err = new Error('Rainforest did not return a payin configuration.');
    err.statusCode = 502;
    throw err;
  }

  let payinDoc = existing;
  if (!payinDoc) {
    payinDoc = await RainforestPayin.create({
      payinConfigId,
      merchantId,
      rainforestAccountRef: account?._id || null,
      invoiceId: invoice._id,
      propertyId: invoice.propertyId || null,
      userId: userOid,
      paymentMethodLocalId: method._id,
      providerPaymentMethodId: method.providerPaymentMethodId,
      methodType: method.type,
      status: PAYIN_STATUS.CREATED,
      invoicePaymentAmount: netAmount,
      chargeAmountCents,
      processingFeeAmount: amountValidation.processingFeeAmount || 0,
      processingFeePaidBy: amountValidation.processingFeePaidBy || '',
      platformFeeCents: amountValidation.platformFeeCents || 0,
      currency: 'USD',
      paymentAttemptId: attemptKey,
      idempotencyKey,
      metadata,
    });
  }

  let remotePayin;
  try {
    remotePayin = await client.createPaymentMethodPayin(
      method.providerPaymentMethodId,
      { payin_config_id: payinConfigId },
      { idempotencyKey: `${idempotencyKey}_payin` }
    );
  } catch (err) {
    payinDoc.status = PAYIN_STATUS.FAILED;
    payinDoc.refusalDesc = err.message || 'Rainforest payin failed.';
    payinDoc.failedAt = ClockService.now();
    await payinDoc.save();
    throw err;
  }

  await syncPayinRecordFromRemote(payinDoc, remotePayin);

  auditRainforest({
    event: AUDIT_EVENTS.PAYIN_CREATED,
    entity: 'RainforestPayin',
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
    const err = new Error(payinDoc.refusalDesc || 'Rainforest declined this payment.');
    err.statusCode = 402;
    err.details = {
      payinId: payinDoc.payinId,
      refusalCode: payinDoc.refusalCode,
      refusalDesc: payinDoc.refusalDesc,
    };
    throw err;
  }

  // Match Payload: always create an in-flight invoice row for non-failed payins
  // (including immediate SUCCEEDED) so settle/notify never hit no_processing_tx.
  if (normalizedStatus !== PAYIN_STATUS.FAILED) {
    try {
      const {
        ensureGatewayProcessingPaymentRecorded,
      } = require('../../../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
      await ensureGatewayProcessingPaymentRecorded({
        invoiceId: invoice._id,
        amount: netAmount,
        method: invoiceMethodLabel(payinDoc.methodType),
        paidBy: userOid,
        recordedBy: userOid,
        gatewayTransactionId: payinDoc._id,
        gatewayExternalId: payinDoc.payinId || payinConfigId,
        note: description || `Rainforest payin initiated - ${payinDoc.payinId || payinConfigId}`,
        skipOwnerPaymentAssert: true,
      });
    } catch (invoiceErr) {
      if (invoiceErr.statusCode === 409 || invoiceErr.statusCode === 400) {
        const err = new Error(invoiceErr.message);
        err.statusCode = invoiceErr.statusCode;
        throw err;
      }
      logger.error('[RainforestPayin] Failed to record invoice processing payment', {
        invoiceId: String(invoice._id),
        payinId: payinDoc.payinId,
        error: invoiceErr.message,
      });
    }
  }

  const lifecycle = await applyRainforestPayinLifecycle({
    payinDoc,
    remotePayload: remotePayin,
    eventType: normalizedStatus === PAYIN_STATUS.PROCESSING ? 'payin.processing' : '',
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
    doc = await RainforestPayin.findOne({ _id: ref, userId: userOid, isDeleted: { $ne: true } });
  }
  if (!doc) {
    doc = await RainforestPayin.findOne({ payinId: ref, userId: userOid, isDeleted: { $ne: true } });
  }
  if (!doc) {
    const err = new Error('Rainforest payin not found.');
    err.statusCode = 404;
    throw err;
  }

  if (doc.payinId) {
    try {
      const remote = await client.getPayin(doc.payinId);
      await syncPayinRecordFromRemote(doc, remote);
    } catch (err) {
      logger.warn('[RainforestPayin] Remote refresh failed', {
        payinId: doc.payinId,
        message: err.message,
      });
    }
  }

  return sanitizePayin(doc);
}

async function applyPayinWebhookUpdate({ payinId, remotePayload = {}, eventType = '' }) {
  if (!payinId) return { processed: false, reason: 'missing_payin_id' };

  let doc = await RainforestPayin.findOne({ payinId: String(payinId), isDeleted: { $ne: true } });
  if (!doc) {
    const metadataInvoiceId =
      remotePayload?.metadata?.invoiceId
      || remotePayload?.metadata?.invoice_id
      || null;
    if (metadataInvoiceId) {
      doc = await RainforestPayin.findOne({
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
    logger.warn('[RainforestPayin] Webhook payin not linked locally', { payinId, eventType });
    return { processed: false, reason: 'payin_not_found' };
  }

  const lifecycle = await applyRainforestPayinLifecycle({
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
  ensureRainforestEnabled();

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

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const invoiceOid = toObjectId(allocation?.invoiceId);
    if (!invoiceOid) {
      issues.push({
        invoiceId: allocation?.invoiceId || null,
        code: 'INVALID_INVOICE',
        message: 'Invalid invoice.',
      });
      continue;
    }

    const invoice = await Invoice.findOne({ _id: invoiceOid, isDeleted: { $ne: true } }).lean();
    if (!invoice) {
      issues.push({
        invoiceId: String(allocation.invoiceId),
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found.',
      });
      continue;
    }

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
      const billingSettings = await getEffectiveBillingSettingsForProperty(invoice.propertyId);
      const feeQuote = calculateRainforestProcessingFee({
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

module.exports = {
  executeInvoicePayin,
  getPayinForUser,
  applyPayinWebhookUpdate,
  applyRainforestPayinLifecycle,
  sanitizePayin,
  buildPayinIdempotencyKey,
  validatePayinAllocations,
};
