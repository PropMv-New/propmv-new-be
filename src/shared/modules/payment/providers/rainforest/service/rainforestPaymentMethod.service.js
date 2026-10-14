'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const RainforestPaymentMethod = require('../model/rainforestPaymentMethod.model');
const RainforestUser = require('../model/rainforestUser.model');
const RainforestAccount = require('../model/rainforestAccount.model');
const { RainforestClient } = require('../client/rainforest.client');
const {
  PAYMENT_METHOD_STATUS,
  PAYMENT_METHOD_TYPE,
  AUDIT_EVENTS,
  MERCHANT_ONBOARDING_STATUS,
  ENTITY_TYPE,
} = require('../constants/rainforest.constants');
const { createPaymentMethodSession } = require('./rainforestComponentSession.service');
const {
  ensureRainforestEnabled,
  syncRainforestAccountFromRemote,
} = require('./rainforestMerchant.service');
const rainforestConfig = require('../../../../../../config/rainforest.config');
const { resolvePlatformIdForBillableMerchant } = require('../utils/rainforestPlatform.util');
const {
  buildHoaBillableMerchantQuery,
  buildEntityBillableMerchantQuery,
  isBillableRainforestMerchantAccount,
  billableMerchantUnavailableMessage,
} = require('../utils/rainforestBillableMerchant.util');
const { auditRainforest } = require('./rainforestAudit.helper');
const {
  allowedMethodsNeedOriginatingMerchant,
  isWalletMethodType,
  RAINFOREST_CARDS_SECTION_ALLOWED_METHODS,
} = require('../utils/rainforestPaymentMethodType.util');
const logger = require('../../../../../../common/logger');

const client = new RainforestClient();

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function normalizeAccountType(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('saving')) return 'savings';
  if (raw.includes('check')) return 'checking';
  return raw || '';
}

function parseLast4FromDescription(description) {
  const match = String(description || '').match(/(\d{4})\s*$/);
  return match ? match[1] : '';
}

function extractDisplayMetadata(remote = {}) {
  const methodType = String(remote?.method_type || remote?.methodType || '').toUpperCase();
  const card = remote?.card || {};
  const ach = remote?.ach || remote?.plaid_ach || remote?.validated_ach || {};
  const applePay = remote?.apple_pay || {};
  const paypalWallet = remote?.paypal_wallet || {};
  const venmo = remote?.venmo || {};
  const paypalPaylater = remote?.paypal_paylater || {};
  const billing = remote?.billing_contact || remote?.billingContact || {};

  const base = {
    accountType: '',
    bankName: '',
    holderName: billing?.name || ach?.account_holder_name || ach?.accountHolderName || '',
    routingNumber: ach?.routing_number || ach?.routingNumber || '',
    fingerprint: remote?.fingerprint || card?.fingerprint || ach?.fingerprint || '',
    methodType: methodType || PAYMENT_METHOD_TYPE.CARD,
    walletLabel: '',
  };

  if (methodType === PAYMENT_METHOD_TYPE.APPLE_PAY) {
    const description = applePay.description || applePay.brand_desc || '';
    return {
      ...base,
      brand: applePay.brand_desc || applePay.brand || 'Apple Pay',
      last4: parseLast4FromDescription(description),
      expMonth: null,
      expYear: null,
      walletLabel: description || 'Apple Pay',
      methodType: PAYMENT_METHOD_TYPE.APPLE_PAY,
    };
  }

  if (methodType === PAYMENT_METHOD_TYPE.PAYPAL_WALLET) {
    const walletLabel =
      paypalWallet.email
      || paypalWallet.description
      || paypalWallet.payer_id
      || 'PayPal';
    return {
      ...base,
      brand: 'PayPal',
      last4: '',
      walletLabel,
      methodType: PAYMENT_METHOD_TYPE.PAYPAL_WALLET,
    };
  }

  if (methodType === PAYMENT_METHOD_TYPE.VENMO) {
    const walletLabel =
      venmo.username
      || venmo.display_name
      || venmo.description
      || 'Venmo';
    return {
      ...base,
      brand: 'Venmo',
      last4: '',
      walletLabel,
      methodType: PAYMENT_METHOD_TYPE.VENMO,
    };
  }

  if (methodType === PAYMENT_METHOD_TYPE.PAYPAL_PAYLATER) {
    return {
      ...base,
      brand: 'PayPal Pay Later',
      last4: '',
      walletLabel: paypalPaylater.description || 'PayPal Pay Later',
      methodType: PAYMENT_METHOD_TYPE.PAYPAL_PAYLATER,
    };
  }

  return {
    ...base,
    brand: card?.brand || '',
    last4: card?.last4
      || ach?.account_number_last_4
      || ach?.account_number_last4
      || ach?.last4
      || '',
    expMonth: card?.exp_month ?? card?.expMonth ?? null,
    expYear: card?.exp_year ?? card?.expYear ?? null,
    accountType: normalizeAccountType(ach?.account_type || ach?.accountType),
    bankName: ach?.bank_name || ach?.bankName || ach?.institution_name || '',
  };
}

function buildDisplayPayload(displayMeta = {}) {
  return {
    brand: displayMeta.brand || '',
    last4: displayMeta.last4 || '',
    expMonth: displayMeta.expMonth ?? null,
    expYear: displayMeta.expYear ?? null,
    accountType: displayMeta.accountType || '',
    bankName: displayMeta.bankName || '',
    holderName: displayMeta.holderName || '',
    routingNumber: displayMeta.routingNumber || '',
    fingerprint: displayMeta.fingerprint || '',
    walletLabel: displayMeta.walletLabel || '',
  };
}

async function refreshPaymentMethodDisplayFromRemote(doc) {
  if (!doc?.providerPaymentMethodId) return doc;

  const type = String(doc.type || '').toUpperCase();
  const isBank = type.includes('ACH') || type.includes('BANK') || type.includes('PLAID');
  const isWallet = isWalletMethodType(type);
  const needsRefresh = isBank
    ? !doc.display?.last4
    : isWallet
      ? !doc.display?.walletLabel && !doc.display?.brand
      : !doc.display?.last4 && !doc.display?.brand;
  if (!needsRefresh) return doc;

  try {
    const remote = await client.getPaymentMethod(doc.providerPaymentMethodId);
    const displayMeta = extractDisplayMetadata(remote || {});
    if (!displayMeta.last4 && !displayMeta.bankName && !displayMeta.holderName && !displayMeta.walletLabel) {
      return doc;
    }

    doc.display = buildDisplayPayload(displayMeta);
    doc.type = displayMeta.methodType || doc.type;
    doc.lastWebhookAt = ClockService.now();
    await doc.save();
  } catch (err) {
    logger.warn('[RainforestPaymentMethod] Display refresh failed', {
      paymentMethodId: doc.providerPaymentMethodId,
      message: err.message,
    });
  }

  return doc;
}

function sanitizePaymentMethod(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(row._id),
    provider: row.provider,
    providerPaymentMethodId: row.providerPaymentMethodId,
    paymentMethodConfigId: row.paymentMethodConfigId || '',
    billableMerchantId: row.billableMerchantId || '',
    type: row.type,
    status: row.status,
    isDefault: !!row.isDefault,
    display: row.display || {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ensureRainforestUserContext({ userId, billableMerchantId, entityType, entityId }) {
  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  const query = {
    userId: userOid,
    billableMerchantId: String(billableMerchantId || ''),
  };

  let record = await RainforestUser.findOne(query);
  if (!record) {
    record = await RainforestUser.create({
      userId: userOid,
      billableMerchantId: String(billableMerchantId || ''),
      entityType: entityType || null,
      entityId: toObjectId(entityId),
      metadata: {},
      lastSyncedAt: ClockService.now(),
    });
  }
  return record;
}

async function initializePaymentMethodSetup({
  userId,
  billableMerchantId,
  entityType,
  entityId,
  allowedMethods = 'CARD,ACH',
  req = null,
}) {
  ensureRainforestEnabled();
  const normalizedAllowedMethods = String(allowedMethods || 'CARD,ACH').toUpperCase().replace(/\s/g, '') === 'CARD'
    ? RAINFOREST_CARDS_SECTION_ALLOWED_METHODS
    : String(allowedMethods || 'CARD,ACH');
  const userOid = toObjectId(userId);
  if (!userOid || !billableMerchantId) {
    const err = new Error(billableMerchantUnavailableMessage({ entityType, entityId }));
    err.statusCode = 400;
    throw err;
  }

  await ensureRainforestUserContext({ userId: userOid, billableMerchantId, entityType, entityId });

  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${userOid}:${billableMerchantId}:${ClockService.nowEpoch()}`)
    .digest('hex')
    .slice(0, 40);

  const platformId = await resolvePlatformIdForBillableMerchant(billableMerchantId);
  if (!platformId) {
    const err = new Error(
      'Rainforest platform is not configured. Set RAINFOREST_PLATFORM_ID in the backend environment.'
    );
    err.statusCode = 503;
    throw err;
  }

  const configPayload = {
    platform_id: platformId,
    idempotency_key: idempotencyKey,
    billable_merchant_id: String(billableMerchantId),
    metadata: {
      propmv_user_id: String(userOid),
      propmv_entity_type: entityType || '',
      propmv_entity_id: entityId ? String(entityId) : '',
      propmv_allowed_methods: String(normalizedAllowedMethods || ''),
    },
  };

  if (allowedMethodsNeedOriginatingMerchant(normalizedAllowedMethods)) {
    configPayload.originating_merchant_id = String(billableMerchantId);
  }

  const config = await client.createPaymentMethodConfig(
    configPayload,
    { idempotencyKey }
  );

  const paymentMethodConfigId = config?.payment_method_config_id || config?.paymentMethodConfigId || '';
  const session = await createPaymentMethodSession({ merchantId: billableMerchantId });

  auditRainforest({
    event: AUDIT_EVENTS.PAYMENT_METHOD_ADDED,
    entity: 'RainforestPaymentMethodConfig',
    entityId: paymentMethodConfigId,
    createdBy: userOid,
    after: { paymentMethodConfigId, billableMerchantId, allowedMethods: normalizedAllowedMethods },
    req,
  });

  return {
    paymentMethodConfigId,
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    billableMerchantId: String(billableMerchantId),
    allowedMethods: normalizedAllowedMethods,
    termsAndConditionsUrl: process.env.RAINFOREST_TERMS_URL || '',
  };
}

async function registerPaymentMethodFromComponent({
  userId,
  paymentMethodId,
  paymentMethodConfigId,
  billableMerchantId,
  req = null,
}) {
  ensureRainforestEnabled();
  const userOid = toObjectId(userId);
  if (!userOid || !paymentMethodId) {
    const err = new Error('Payment method id is required.');
    err.statusCode = 400;
    throw err;
  }

  let remote = null;
  try {
    remote = await client.getPaymentMethod(paymentMethodId);
  } catch (err) {
    logger.warn('[RainforestPaymentMethod] Remote lookup failed during register', { paymentMethodId, message: err.message });
  }

  const displayMeta = extractDisplayMetadata(remote || {});
  const type = displayMeta.methodType || PAYMENT_METHOD_TYPE.CARD;
  const status = String(remote?.status || PAYMENT_METHOD_STATUS.ACTIVE).toUpperCase();

  const existing = await RainforestPaymentMethod.findOne({
    providerPaymentMethodId: String(paymentMethodId),
  });

  if (existing) {
    if (String(existing.userId) !== String(userOid)) {
      const err = new Error('Payment method belongs to another user.');
      err.statusCode = 403;
      throw err;
    }
    existing.display = buildDisplayPayload(displayMeta);
    existing.type = type || existing.type;
    existing.status = status || existing.status;
    existing.lastWebhookAt = ClockService.now();
    await existing.save();
    return sanitizePaymentMethod(existing);
  }

  const doc = await RainforestPaymentMethod.create({
    userId: userOid,
    providerPaymentMethodId: String(paymentMethodId),
    paymentMethodConfigId: paymentMethodConfigId || remote?.payment_method_config_id || '',
    billableMerchantId: billableMerchantId || remote?.billable_merchant_id || '',
    type,
    status,
    display: buildDisplayPayload(displayMeta),
    metadata: {
      propmv_registered_at: ClockService.now(),
    },
    lastWebhookAt: ClockService.now(),
  });

  auditRainforest({
    event: AUDIT_EVENTS.PAYMENT_METHOD_ADDED,
    entity: 'RainforestPaymentMethod',
    entityId: doc._id,
    createdBy: userOid,
    after: sanitizePaymentMethod(doc),
    req,
  });

  return sanitizePaymentMethod(doc);
}

async function listUserPaymentMethods(userId) {
  const userOid = toObjectId(userId);
  if (!userOid) return [];

  const rows = await RainforestPaymentMethod.find({
    userId: userOid,
    isDeleted: { $ne: true },
    status: { $in: [PAYMENT_METHOD_STATUS.ACTIVE, PAYMENT_METHOD_STATUS.CREATED] },
  }).sort({ isDefault: -1, createdAt: -1 });

  await Promise.all(rows.map((row) => refreshPaymentMethodDisplayFromRemote(row)));

  return rows.map(sanitizePaymentMethod);
}

async function applyPaymentMethodWebhookUpdate({ paymentMethodId, status, remotePayload = null }) {
  const doc = await RainforestPaymentMethod.findOne({
    providerPaymentMethodId: String(paymentMethodId),
    isDeleted: { $ne: true },
  });

  if (!doc && remotePayload) {
    const metadataUserId = remotePayload?.metadata?.propmv_user_id;
    const userOid = toObjectId(metadataUserId);
    if (!userOid) return null;

    const displayMeta = extractDisplayMetadata(remotePayload);
    const created = await RainforestPaymentMethod.create({
      userId: userOid,
      providerPaymentMethodId: String(paymentMethodId),
      paymentMethodConfigId: remotePayload?.payment_method_config_id || '',
      billableMerchantId: remotePayload?.billable_merchant_id || '',
      type: displayMeta.methodType || PAYMENT_METHOD_TYPE.CARD,
      status: String(status || remotePayload?.status || PAYMENT_METHOD_STATUS.ACTIVE).toUpperCase(),
      display: buildDisplayPayload(displayMeta),
      metadata: { source: 'webhook' },
      lastWebhookAt: ClockService.now(),
    });

    auditRainforest({
      event: AUDIT_EVENTS.PAYMENT_METHOD_STATUS_UPDATED,
      entity: 'RainforestPaymentMethod',
      entityId: created._id,
      createdBy: userOid,
      after: sanitizePaymentMethod(created),
    });

    return created;
  }

  if (!doc) return null;

  const before = sanitizePaymentMethod(doc);
  doc.status = String(status || doc.status).toUpperCase();
  if (remotePayload) {
    const displayMeta = extractDisplayMetadata(remotePayload);
    doc.display = buildDisplayPayload({
      brand: displayMeta.brand || doc.display?.brand || '',
      last4: displayMeta.last4 || doc.display?.last4 || '',
      expMonth: displayMeta.expMonth ?? doc.display?.expMonth ?? null,
      expYear: displayMeta.expYear ?? doc.display?.expYear ?? null,
      accountType: displayMeta.accountType || doc.display?.accountType || '',
      bankName: displayMeta.bankName || doc.display?.bankName || '',
      holderName: displayMeta.holderName || doc.display?.holderName || '',
      routingNumber: displayMeta.routingNumber || doc.display?.routingNumber || '',
      fingerprint: displayMeta.fingerprint || doc.display?.fingerprint || '',
    });
    doc.type = displayMeta.methodType || doc.type;
  }
  doc.lastWebhookAt = ClockService.now();
  await doc.save();

  auditRainforest({
    event: AUDIT_EVENTS.PAYMENT_METHOD_STATUS_UPDATED,
    entity: 'RainforestPaymentMethod',
    entityId: doc._id,
    createdBy: doc.userId,
    before,
    after: sanitizePaymentMethod(doc),
  });

  return doc;
}

async function findActiveBillableMerchantId(scopedQuery) {
  if (!scopedQuery) return '';

  const activeLocal = await RainforestAccount.findOne({
    ...scopedQuery,
    onboardingStatus: MERCHANT_ONBOARDING_STATUS.ACTIVE,
  }).sort({ updatedAt: -1 });
  if (activeLocal?.merchantId) return activeLocal.merchantId;

  const candidates = await RainforestAccount.find(scopedQuery).sort({ updatedAt: -1 });
  for (const candidate of candidates) {
    try {
      await syncRainforestAccountFromRemote(candidate);
      const refreshed = await RainforestAccount.findById(candidate._id);
      if (isBillableRainforestMerchantAccount(refreshed)) {
        return refreshed.merchantId;
      }
    } catch (err) {
      logger.warn('[RainforestPaymentMethod] Billable merchant sync failed', {
        merchantId: candidate.merchantId,
        message: err.message,
      });
    }
  }

  return '';
}

async function resolveBillableMerchantForUser({ userId, entityType, entityId, businessId }) {
  void userId;

  if (entityType === ENTITY_TYPE.HOA && entityId) {
    const hoaQuery = buildHoaBillableMerchantQuery(entityId);
    const merchantId = await findActiveBillableMerchantId(hoaQuery);
    if (merchantId) return merchantId;
  } else if (entityType && businessId) {
    const entityQuery = buildEntityBillableMerchantQuery({ entityType, businessId, toObjectId });
    const merchantId = await findActiveBillableMerchantId(entityQuery);
    if (merchantId) return merchantId;
  }

  return '';
}

module.exports = {
  initializePaymentMethodSetup,
  registerPaymentMethodFromComponent,
  listUserPaymentMethods,
  applyPaymentMethodWebhookUpdate,
  resolveBillableMerchantForUser,
  sanitizePaymentMethod,
};
