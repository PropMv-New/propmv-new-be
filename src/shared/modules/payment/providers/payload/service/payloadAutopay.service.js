'use strict';

const mongoose = require('mongoose');
const OwnerPayloadAutopay = require('../model/ownerPayloadAutopay.model');
const PayloadPaymentMethod = require('../model/payloadPaymentMethod.model');
const payloadConfig = require('../../../../../../config/payload.config');
const {
  ENTITY_TYPE,
  AUTOPAY_ELIGIBLE_PAYMENT_METHOD_TYPES,
  PAYMENT_METHOD_STATUS,
  AUDIT_EVENTS,
} = require('../constants/payload.constants');
const { ensurePayloadEnabled } = require('./payloadMerchant.service');
const {
  updatePaymentMethodForUser,
  ensurePayloadUserContext,
  ensurePayloadCustomerForUser,
} = require('./payloadPaymentMethod.service');
const {
  resolveHoaOwnerPayloadCustomerContext,
  isPayloadOwnerMethodInHoaScope,
} = require('../utils/payloadHoaOwnerCustomerContext.util');
const { findActiveBillableMerchantId } = require('../utils/payloadBillableMerchant.util');
const { resolvePayloadPrimaryProcessingIdForOwnerWallet } = require('../utils/payloadHoaOwnerProcessingAccount.util');
const { PayloadClient } = require('../client/payload.client');
const Invoice = require('../../../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const PayloadPayin = require('../model/payloadPayin.model');
const { syncOpenInvoicesForOwner } = require('./payloadInvoiceSync.service');
const { isInvoiceEligibleForAutopaySync } = require('../utils/payloadInvoiceSync.util');
const { buildOwnerAutopayInvoiceMongoFilter } = require('../utils/payloadAutopayInvoiceScope.util');
const { calculatePayloadProcessingFee } = require('../utils/payloadPayinFee.util');
const { getEffectiveBillingSettingsForProperty } = require('../../../../billing-settings/service/billingSettings.service');
const { roundMoney } = require('../utils/payloadPayinSettlement.util');
const { PAYIN_STATUS } = require('../constants/payload.constants');
const { auditPayload } = require('./payloadAudit.helper');
const { ClockService } = require('../../../../../../common/date');
const logger = require('../../../../../../common/logger');

const client = new PayloadClient();

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function ensureOwnerAutopayFeatureEnabled() {
  ensurePayloadEnabled();
  if (!payloadConfig.payload.ownerAutopayEnabled) {
    const err = new Error('Owner autopay is not enabled.');
    err.statusCode = 403;
    throw err;
  }
}

function sanitizeAutopay(doc, paymentMethod = null, extras = {}) {
  if (!doc) return null;
  const { sanitizePaymentMethod } = require('./payloadPaymentMethod.service');
  return {
    enabled: !!doc.enabled,
    hoaId: String(doc.hoaId),
    userId: String(doc.userId),
    payloadCustomerId: doc.payloadCustomerId || '',
    paymentMethodLocalId: doc.payloadPaymentMethodLocalId ? String(doc.payloadPaymentMethodLocalId) : null,
    providerPaymentMethodId: doc.providerPaymentMethodId || '',
    enrolledAt: doc.enrolledAt || null,
    disabledAt: doc.disabledAt || null,
    lastSyncedAt: doc.lastSyncedAt || null,
    paymentMethod: paymentMethod ? sanitizePaymentMethod(paymentMethod) : null,
    nextAutopay: extras.nextAutopay ?? null,
    lastAutopayAttempt: extras.lastAutopayAttempt ?? null,
  };
}

async function computeNextAutopayForOwner({ userId, hoaId, paymentMethod }) {
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid) return null;

  const filter = await buildOwnerAutopayInvoiceMongoFilter({
    userId: userOid,
    hoaId: hoaOid,
    extra: {
      balanceDue: { $gt: 0 },
      dueDate: { $exists: true, $ne: null },
    },
  });
  if (!filter) return null;

  const candidates = await Invoice.find(filter)
    .sort({ dueDate: 1, createdAt: 1 })
    .limit(5)
    .lean();

  const invoice = candidates.find((row) => isInvoiceEligibleForAutopaySync(row));
  if (!invoice) return null;

  const methodType = paymentMethod?.type || 'CARD';
  const invoicePaymentAmount = roundMoney(invoice.balanceDue || 0);
  const billingSettings = await getEffectiveBillingSettingsForProperty(invoice.propertyId);
  const feeQuote = calculatePayloadProcessingFee({
    invoicePaymentAmount,
    methodType,
    billingSettings,
    applyFee: true,
  });

  return {
    propmvInvoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceId || '',
    nextChargeDate: invoice.dueDate || null,
    nextInvoicePaymentAmount: feeQuote.invoicePaymentAmount,
    nextProcessingFeeAmount: feeQuote.processingFeeAmount,
    nextChargeAmount: feeQuote.chargeAmount,
  };
}

async function computeLastAutopayAttemptForOwner({ userId, hoaId }) {
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid) return null;

  const filter = await buildOwnerAutopayInvoiceMongoFilter({
    userId: userOid,
    hoaId: hoaOid,
  });
  if (!filter) return null;

  const invoiceIds = await Invoice.find(filter).distinct('_id');

  if (!invoiceIds.length) return null;

  const payin = await PayloadPayin.findOne({
    userId: userOid,
    invoiceId: { $in: invoiceIds },
    isDeleted: { $ne: true },
    'metadata.trigger': 'automatic',
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  if (!payin) return null;

  const status = String(payin.status || '').trim().toUpperCase();
  let outcome = 'pending';
  if (status === PAYIN_STATUS.SUCCEEDED || payin.settledAt) {
    outcome = 'succeeded';
  } else if ([PAYIN_STATUS.FAILED, PAYIN_STATUS.RETURNED, PAYIN_STATUS.CANCELED].includes(status)) {
    outcome = 'failed';
  } else if (status === PAYIN_STATUS.PROCESSING || status === PAYIN_STATUS.CREATED) {
    outcome = 'processing';
  }

  return {
    payinId: payin.payinId || '',
    propmvInvoiceId: payin.invoiceId ? String(payin.invoiceId) : '',
    amount: roundMoney(payin.invoicePaymentAmount || 0),
    status,
    outcome,
    attemptedAt: payin.updatedAt || payin.createdAt || null,
    refusalDesc: payin.refusalDesc || '',
  };
}

async function assertEligiblePaymentMethodForAutopay({
  userId,
  localMethodId,
  hoaId,
}) {
  const userOid = toObjectId(userId);
  const methodOid = toObjectId(localMethodId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !methodOid || !hoaOid) {
    const err = new Error('Invalid autopay request.');
    err.statusCode = 400;
    throw err;
  }

  const method = await PayloadPaymentMethod.findOne({
    _id: methodOid,
    userId: userOid,
    isDeleted: { $ne: true },
  });
  if (!method) {
    const err = new Error('Payment method not found.');
    err.statusCode = 404;
    throw err;
  }

  const normalizedType = String(method.type || '').trim().toUpperCase();
  if (!AUTOPAY_ELIGIBLE_PAYMENT_METHOD_TYPES.has(normalizedType)) {
    const err = new Error('This payment method cannot be used for Auto Pay.');
    err.statusCode = 422;
    throw err;
  }

  const status = String(method.status || '').trim().toUpperCase();
  const inactiveStatuses = new Set([
    PAYMENT_METHOD_STATUS.DEACTIVATED,
    PAYMENT_METHOD_STATUS.CANCELED,
    PAYMENT_METHOD_STATUS.FAILED,
    PAYMENT_METHOD_STATUS.REPLACED,
  ]);
  if (status && inactiveStatuses.has(status)) {
    const err = new Error('Payment method is not active.');
    err.statusCode = 422;
    throw err;
  }

  if (!String(method.providerPaymentMethodId || '').trim()) {
    const err = new Error('Payment method is not fully registered with Payload.');
    err.statusCode = 422;
    throw err;
  }

  const hoaContext = await resolveHoaOwnerPayloadCustomerContext(hoaOid, {
    findActiveBillableMerchantId,
    ownerUserId: userOid,
  });
  if (!hoaContext.primaryProcessingId) {
    const err = new Error('HOA payment processing is not available for Auto Pay.');
    err.statusCode = 422;
    throw err;
  }

  if (!isPayloadOwnerMethodInHoaScope(method, hoaOid, hoaContext)) {
    const err = new Error('Payment method does not belong to this HOA.');
    err.statusCode = 403;
    throw err;
  }

  return { method, hoaContext };
}

async function resolvePayloadCustomerIdForEnrollment({ userId, hoaId, hoaContext }) {
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  const primaryProcessingId = resolvePayloadPrimaryProcessingIdForOwnerWallet({
    primaryProcessingId: hoaContext.primaryProcessingId,
    merchantIds: hoaContext.merchantIds,
  });

  const payloadUser = await ensurePayloadUserContext({
    userId: userOid,
    billableMerchantId: hoaContext.scopeKey,
    entityType: ENTITY_TYPE.HOA,
    entityId: hoaOid,
  });

  const customerId = await ensurePayloadCustomerForUser({
    userId: userOid,
    billableMerchantId: hoaContext.scopeKey,
    primaryProcessingId,
    hoaMerchantIds: hoaContext.merchantIds || [],
    hoaId: hoaOid,
    payloadUserRecord: payloadUser,
  });

  if (!customerId) {
    const err = new Error('Unable to resolve Payload customer for Auto Pay.');
    err.statusCode = 422;
    throw err;
  }
  return String(customerId);
}

async function getOwnerAutopayStatus({ userId, hoaId }) {
  ensureOwnerAutopayFeatureEnabled();
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid) {
    const err = new Error('HOA context is required.');
    err.statusCode = 400;
    throw err;
  }

  const doc = await OwnerPayloadAutopay.findOne({
    userId: userOid,
    hoaId: hoaOid,
  });

  let paymentMethod = null;
  if (doc?.payloadPaymentMethodLocalId) {
    paymentMethod = await PayloadPaymentMethod.findOne({
      _id: doc.payloadPaymentMethodLocalId,
      userId: userOid,
      isDeleted: { $ne: true },
    });
  }

  const base = doc || { enabled: false, userId: userOid, hoaId: hoaOid };
  const nextAutopay = await computeNextAutopayForOwner({
    userId: userOid,
    hoaId: hoaOid,
    paymentMethod: base.enabled ? paymentMethod : null,
  });
  const lastAutopayAttempt = base.enabled
    ? await computeLastAutopayAttemptForOwner({ userId: userOid, hoaId: hoaOid })
    : null;

  return sanitizeAutopay(base, paymentMethod, { nextAutopay, lastAutopayAttempt });
}

async function enableOwnerAutopay({
  userId,
  hoaId,
  paymentMethodLocalId,
  confirmAutopay = false,
  req = null,
}) {
  ensureOwnerAutopayFeatureEnabled();
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);

  if (!confirmAutopay) {
    const err = new Error('Please confirm Auto Pay enrollment before enabling.');
    err.statusCode = 400;
    throw err;
  }

  const { method, hoaContext } = await assertEligiblePaymentMethodForAutopay({
    userId: userOid,
    localMethodId: paymentMethodLocalId,
    hoaId: hoaOid,
  });

  const payloadCustomerId = await resolvePayloadCustomerIdForEnrollment({
    userId: userOid,
    hoaId: hoaOid,
    hoaContext,
  });

  await updatePaymentMethodForUser({
    userId: userOid,
    localMethodId: method._id,
    isDefault: true,
    entityType: ENTITY_TYPE.HOA,
    entityId: String(hoaOid),
    req,
  });

  const now = ClockService.now();
  const doc = await OwnerPayloadAutopay.findOneAndUpdate(
    { userId: userOid, hoaId: hoaOid },
    {
      $set: {
        enabled: true,
        payloadPaymentMethodLocalId: method._id,
        providerPaymentMethodId: method.providerPaymentMethodId,
        payloadCustomerId,
        enrolledAt: now,
        disabledAt: null,
        lastSyncedAt: now,
      },
    },
    { upsert: true, new: true },
  );

  auditPayload({
    event: AUDIT_EVENTS.AUTOPAY_ENABLED,
    entity: 'OwnerPayloadAutopay',
    entityId: doc._id,
    createdBy: userOid,
    after: sanitizeAutopay(doc, method),
    req,
  });

  setImmediate(() => {
    syncOpenInvoicesForOwner({
      userId: userOid,
      hoaId: hoaOid,
      enrollment: doc,
      paymentMethod: method,
    }).catch((err) => {
      logger.warn('[PayloadAutopay] Invoice backfill after enable failed', {
        userId: String(userOid),
        hoaId: String(hoaOid),
        message: err.message,
      });
    });
  });

  return getOwnerAutopayStatus({ userId: userOid, hoaId: hoaOid });
}

async function disableOwnerAutopay({ userId, hoaId, req = null }) {
  ensureOwnerAutopayFeatureEnabled();
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  const doc = await OwnerPayloadAutopay.findOne({ userId: userOid, hoaId: hoaOid });
  if (!doc || !doc.enabled) {
    return sanitizeAutopay(doc || { enabled: false, userId: userOid, hoaId: hoaOid });
  }

  const { closePayloadMirrorInvoice } = require('./payloadInvoiceSync.service');
  const mirrorFilter = await buildOwnerAutopayInvoiceMongoFilter({
    userId: userOid,
    hoaId: hoaOid,
    extra: {
      'payloadAutopayMirror.payloadInvoiceId': { $exists: true, $ne: '' },
    },
  });
  const mirroredInvoices = mirrorFilter
    ? await Invoice.find(mirrorFilter).limit(200)
    : [];
  for (const invoice of mirroredInvoices) {
    await closePayloadMirrorInvoice(invoice, { reason: 'autopay_disabled' }).catch(() => {});
  }

  if (doc.providerPaymentMethodId && client.isConfigured()) {
    try {
      await client.updatePaymentMethod(doc.providerPaymentMethodId, {
        default_payment_method: false,
      });
    } catch (err) {
      logger.warn('[PayloadAutopay] Failed to clear Payload default payment method', {
        providerPaymentMethodId: doc.providerPaymentMethodId,
        message: err.message,
      });
    }
  }

  doc.enabled = false;
  doc.disabledAt = ClockService.now();
  await doc.save();

  auditPayload({
    event: AUDIT_EVENTS.AUTOPAY_DISABLED,
    entity: 'OwnerPayloadAutopay',
    entityId: doc._id,
    createdBy: userOid,
    after: sanitizeAutopay(doc),
    req,
  });

  return sanitizeAutopay(doc);
}

async function changeOwnerAutopayPaymentMethod({
  userId,
  hoaId,
  paymentMethodLocalId,
  req = null,
}) {
  ensureOwnerAutopayFeatureEnabled();
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  const doc = await OwnerPayloadAutopay.findOne({ userId: userOid, hoaId: hoaOid, enabled: true });
  if (!doc) {
    const err = new Error('Auto Pay is not enabled.');
    err.statusCode = 409;
    throw err;
  }

  const { method } = await assertEligiblePaymentMethodForAutopay({
    userId: userOid,
    localMethodId: paymentMethodLocalId,
    hoaId: hoaOid,
  });

  const previousProviderId = doc.providerPaymentMethodId;
  if (previousProviderId && previousProviderId !== method.providerPaymentMethodId && client.isConfigured()) {
    try {
      await client.updatePaymentMethod(previousProviderId, { default_payment_method: false });
    } catch (err) {
      logger.warn('[PayloadAutopay] Failed to clear previous default payment method', {
        providerPaymentMethodId: previousProviderId,
        message: err.message,
      });
    }
  }

  await updatePaymentMethodForUser({
    userId: userOid,
    localMethodId: method._id,
    isDefault: true,
    entityType: ENTITY_TYPE.HOA,
    entityId: String(hoaOid),
    req,
  });

  doc.payloadPaymentMethodLocalId = method._id;
  doc.providerPaymentMethodId = method.providerPaymentMethodId;
  doc.lastSyncedAt = ClockService.now();
  await doc.save();

  auditPayload({
    event: AUDIT_EVENTS.AUTOPAY_PAYMENT_METHOD_CHANGED,
    entity: 'OwnerPayloadAutopay',
    entityId: doc._id,
    createdBy: userOid,
    after: sanitizeAutopay(doc, method),
    req,
  });

  setImmediate(() => {
    syncOpenInvoicesForOwner({
      userId: userOid,
      hoaId: hoaOid,
      enrollment: doc,
      paymentMethod: method,
    }).catch(() => {});
  });

  return getOwnerAutopayStatus({ userId: userOid, hoaId: hoaOid });
}

async function disableAutopayIfUsingPaymentMethod({
  userId,
  localMethodIds = [],
  providerPaymentMethodIds = [],
}) {
  if (!payloadConfig.payload.ownerAutopayEnabled) return { updated: 0 };
  const userOid = toObjectId(userId);
  if (!userOid) return { updated: 0 };

  const localIds = localMethodIds.map((id) => toObjectId(id)).filter(Boolean);
  const providerIds = providerPaymentMethodIds.map((id) => String(id || '').trim()).filter(Boolean);

  const query = {
    userId: userOid,
    enabled: true,
    $or: [],
  };
  if (localIds.length) query.$or.push({ payloadPaymentMethodLocalId: { $in: localIds } });
  if (providerIds.length) query.$or.push({ providerPaymentMethodId: { $in: providerIds } });
  if (!query.$or.length) return { updated: 0 };

  const rows = await OwnerPayloadAutopay.find(query);
  let updated = 0;
  for (const row of rows) {
    await disableOwnerAutopay({ userId: userOid, hoaId: row.hoaId });
    updated += 1;
  }
  return { updated };
}

module.exports = {
  getOwnerAutopayStatus,
  enableOwnerAutopay,
  disableOwnerAutopay,
  changeOwnerAutopayPaymentMethod,
  disableAutopayIfUsingPaymentMethod,
  assertEligiblePaymentMethodForAutopay,
  sanitizeAutopay,
};
