'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const RainforestAccount = require('../model/rainforestAccount.model');
const { RainforestClient } = require('../client/rainforest.client');
const {
  MERCHANT_ONBOARDING_STATUS,
  MERCHANT_STATUS,
  AUDIT_EVENTS,
  ENTITY_TYPE,
} = require('../constants/rainforest.constants');
const { mapRainforestMerchantStatus, merchantStatusLabel } = require('../utils/rainforestStatus.util');
const { auditRainforest } = require('./rainforestAudit.helper');
const {
  assertAccountAccess,
  resolveHoaBoardEntityId,
  isHoaBoardAccount,
} = require('../../../account/service/accountAccess.helper');
const { toUserFriendlyRainforestMessage } = require('../utils/rainforestUserError.util');
const { pickPlatformId } = require('../utils/rainforestPlatform.util');
const rainforestConfig = require('../../../../../../config/rainforest.config');
const logger = require('../../../../../../common/logger');

const client = new RainforestClient();

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function ensureRainforestEnabled() {
  if (!rainforestConfig.rainforest.enabled) {
    const err = new Error('Rainforest payments are not enabled for this environment.');
    err.statusCode = 503;
    throw err;
  }
  if (!client.isConfigured()) {
    const err = new Error('Rainforest is not configured. Contact support.');
    err.statusCode = 503;
    throw err;
  }
}

function assertRainforestMerchantAccess(account, { businessId, userId }) {
  if (!account || account.isDeleted) {
    const err = new Error('Business account not found.');
    err.statusCode = 404;
    throw err;
  }

  if (account.entityType === ENTITY_TYPE.HOA) {
    if (userId && account.createdBy && String(account.createdBy) === String(userId)) return;
    if (businessId && String(account.businessId) === String(businessId)) return;
  }

  assertAccountAccess(account, { businessId, userId });
}

function resolveRainforestOwnership({ entityType, clientEntityId, userId, businessId }) {
  const businessOid = toObjectId(businessId);
  if (!businessOid) {
    const err = new Error('A company association is required to create a Rainforest business account.');
    err.statusCode = 400;
    throw err;
  }

  if (isHoaBoardAccount(entityType) && userId) {
    const { entityId, metadataHoaId } = resolveHoaBoardEntityId(userId, clientEntityId);
    return {
      businessId: businessOid,
      entityId: toObjectId(entityId),
      metadata: metadataHoaId ? { hoaId: String(metadataHoaId) } : {},
    };
  }

  const entityId = new mongoose.Types.ObjectId();
  return {
    businessId: businessOid,
    entityId,
    metadata: clientEntityId ? { scopeEntityId: String(clientEntityId) } : {},
  };
}

function buildExternalId({ entityType, entityId, createdBy, metadata = {} }) {
  if (entityType === ENTITY_TYPE.HOA && metadata?.hoaId && createdBy) {
    return `rainforest_${entityType}_${String(createdBy)}_${String(metadata.hoaId)}_${String(entityId)}`;
  }
  return `rainforest_${entityType}_${String(entityId)}`;
}

function buildRainforestMerchantName(accountName, externalId) {
  const display = String(accountName || 'PropMv Business').trim().slice(0, 80) || 'PropMv Business';
  const suffix = String(externalId).replace(/[^a-zA-Z0-9]/g, '').slice(-12);
  return `${display} ${suffix}`.trim().slice(0, 200);
}

function sanitizeMerchantRecord(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(row._id),
    provider: row.provider,
    entityType: row.entityType,
    entityId: String(row.entityId),
    accountName: row.accountName || row.merchantName || '',
    merchantId: row.merchantId || '',
    merchantApplicationId: row.merchantApplicationId || '',
    merchantName: row.merchantName || '',
    merchantStatus: row.merchantStatus || '',
    applicationStatus: row.applicationStatus || '',
    onboardingStatus: row.onboardingStatus || MERCHANT_ONBOARDING_STATUS.NOT_STARTED,
    onboardingStatusLabel: merchantStatusLabel(row.onboardingStatus),
    metadata: row.metadata || {},
    lastSyncedAt: row.lastSyncedAt || null,
    lastWebhookAt: row.lastWebhookAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

async function findAccountById(accountId) {
  const oid = toObjectId(accountId);
  if (!oid) return null;
  return RainforestAccount.findOne({ _id: oid, isDeleted: { $ne: true } });
}

async function syncRainforestAccountFromRemote(account) {
  if (!account?.merchantId) return account;

  try {
    const remote = await client.getMerchant(account.merchantId);
    const application = remote?.latest_merchant_application || {};
    account.merchantStatus = String(remote?.status || remote?.merchant_status || account.merchantStatus).toUpperCase();
    account.applicationStatus = String(application?.status || account.applicationStatus).toUpperCase();
    account.merchantApplicationId = application?.merchant_application_id || account.merchantApplicationId;
    account.onboardingStatus = mapRainforestMerchantStatus(account.merchantStatus, account.applicationStatus);

    const platformId = pickPlatformId(remote);
    if (platformId) {
      account.metadata = {
        ...(account.metadata || {}),
        rainforestPlatformId: platformId,
      };
    }

    account.lastSyncedAt = ClockService.now();
    await account.save();
  } catch (syncErr) {
    logger.warn('[RainforestMerchant] Remote sync failed', {
      merchantId: account.merchantId,
      message: syncErr.message,
    });
  }

  return account;
}

async function listMerchantAccounts({ entityType, businessId, createdBy, hoaId } = {}) {
  const query = { isDeleted: { $ne: true } };

  if (entityType === ENTITY_TYPE.HOA && createdBy) {
    query.entityType = ENTITY_TYPE.HOA;
    query.createdBy = toObjectId(createdBy);
    if (hoaId) query['metadata.hoaId'] = String(hoaId);
  } else {
    if (businessId) query.businessId = toObjectId(businessId);
    else if (createdBy) query.createdBy = toObjectId(createdBy);
    if (entityType) query.entityType = entityType;
  }

  const rows = await RainforestAccount.find(query).sort({ createdAt: -1 });
  await Promise.all(rows.map((account) => syncRainforestAccountFromRemote(account)));
  return rows.map(sanitizeMerchantRecord);
}

async function initializeMerchantOnboarding({
  entityType,
  entityId: clientEntityId,
  businessId,
  accountName,
  merchantName,
  createdBy,
  req = null,
}) {
  ensureRainforestEnabled();

  const userOid = toObjectId(createdBy);
  const displayName = String(accountName || merchantName || '').trim();
  if (!displayName) {
    const err = new Error('Business name is required to create a Rainforest merchant account.');
    err.statusCode = 400;
    throw err;
  }

  const ownership = resolveRainforestOwnership({
    entityType,
    clientEntityId,
    userId: createdBy,
    businessId,
  });

  const externalId = buildExternalId({
    entityType,
    entityId: ownership.entityId,
    createdBy,
    metadata: ownership.metadata,
  });
  const rainforestName = buildRainforestMerchantName(displayName, externalId);
  const idempotencyKey = crypto.createHash('sha256').update(externalId).digest('hex').slice(0, 40);

  const rainforestPayload = {
    name: rainforestName,
    metadata: {
      propmv_external_id: externalId,
      propmv_entity_type: entityType,
      propmv_entity_id: String(ownership.entityId),
      propmv_business_id: String(ownership.businessId),
      propmv_account_name: displayName,
      ...(ownership.metadata?.hoaId ? { propmv_hoa_id: String(ownership.metadata.hoaId) } : {}),
    },
  };

  let created;
  try {
    created = await client.createMerchant(rainforestPayload, { idempotencyKey });
  } catch (err) {
    err.message = toUserFriendlyRainforestMessage(err.statusCode || 400, err.message);
    throw err;
  }

  const merchantId = created?.merchant_id || created?.merchantId || '';
  const application = created?.latest_merchant_application || created?.latestMerchantApplication || {};
  const merchantApplicationId =
    application?.merchant_application_id
    || application?.merchantApplicationId
    || created?.merchant_application_id
    || created?.merchantApplicationId
    || '';
  const merchantStatus = String(
    created?.status || created?.merchant_status || MERCHANT_STATUS.PENDING
  ).toUpperCase();
  const applicationStatus = String(
    application?.status || created?.merchant_application_status || 'CREATED'
  ).toUpperCase();
  const onboardingStatus = mapRainforestMerchantStatus(merchantStatus, applicationStatus);
  const platformId = pickPlatformId(created);

  let account;
  try {
    account = await RainforestAccount.create({
      businessId: ownership.businessId,
      entityType,
      entityId: ownership.entityId,
      externalId,
      accountName: displayName,
      merchantId,
      merchantApplicationId,
      merchantName: rainforestName,
      merchantStatus,
      applicationStatus,
      onboardingStatus,
      metadata: {
        ...ownership.metadata,
        ...(platformId ? { rainforestPlatformId: platformId } : {}),
      },
      environment: rainforestConfig.rainforest.environment,
      lastSyncedAt: ClockService.now(),
      createdBy: userOid,
      updatedBy: userOid,
    });
  } catch (createErr) {
    if (createErr?.code === 11000) {
      account = await RainforestAccount.findOne({ externalId, isDeleted: { $ne: true } });
      if (account) return sanitizeMerchantRecord(account);
    }
    throw createErr;
  }

  auditRainforest({
    event: AUDIT_EVENTS.MERCHANT_CREATED,
    entity: 'RainforestAccount',
    entityId: account._id,
    createdBy,
    after: sanitizeMerchantRecord(account),
    req,
  });

  return sanitizeMerchantRecord(account);
}

async function getMerchantOnboardingStatus({ accountId, businessId, userId }) {
  ensureRainforestEnabled();
  const account = await findAccountById(accountId);
  if (!account) {
    const err = new Error('Rainforest business account not found.');
    err.statusCode = 404;
    throw err;
  }

  assertRainforestMerchantAccess(account, { businessId, userId });

  await syncRainforestAccountFromRemote(account);

  return sanitizeMerchantRecord(account);
}

async function findAccountByMerchantId(merchantId) {
  if (!merchantId) return null;
  return RainforestAccount.findOne({ merchantId: String(merchantId), isDeleted: { $ne: true } });
}

async function applyMerchantWebhookUpdate({ merchantId, merchantStatus, applicationStatus, webhookAt = null }) {
  const account = await findAccountByMerchantId(merchantId);
  if (!account) return null;

  const before = sanitizeMerchantRecord(account);
  account.merchantStatus = String(merchantStatus || account.merchantStatus).toUpperCase();
  if (applicationStatus) account.applicationStatus = String(applicationStatus).toUpperCase();
  account.onboardingStatus = mapRainforestMerchantStatus(account.merchantStatus, account.applicationStatus);
  account.lastWebhookAt = webhookAt || ClockService.now();
  account.lastSyncedAt = ClockService.now();
  await account.save();

  auditRainforest({
    event: AUDIT_EVENTS.MERCHANT_STATUS_UPDATED,
    entity: 'RainforestAccount',
    entityId: account._id,
    before,
    after: sanitizeMerchantRecord(account),
  });

  return account;
}

async function applyMerchantApplicationWebhookUpdate({
  merchantId,
  merchantApplicationId,
  applicationStatus,
  webhookAt = null,
}) {
  const account = await findAccountByMerchantId(merchantId);
  if (!account) return null;

  const before = sanitizeMerchantRecord(account);
  if (merchantApplicationId) account.merchantApplicationId = String(merchantApplicationId);
  if (applicationStatus) account.applicationStatus = String(applicationStatus).toUpperCase();
  account.onboardingStatus = mapRainforestMerchantStatus(account.merchantStatus, account.applicationStatus);
  account.lastWebhookAt = webhookAt || ClockService.now();
  account.lastSyncedAt = ClockService.now();
  await account.save();

  auditRainforest({
    event: AUDIT_EVENTS.MERCHANT_STATUS_UPDATED,
    entity: 'RainforestAccount',
    entityId: account._id,
    before,
    after: sanitizeMerchantRecord(account),
  });

  return account;
}

async function simulateSandboxMerchantApproval({
  accountId,
  businessId,
  userId,
  req = null,
}) {
  ensureRainforestEnabled();
  if (!rainforestConfig.isRainforestSandbox()) {
    const err = new Error('Merchant approval simulation is only available in Rainforest sandbox.');
    err.statusCode = 400;
    throw err;
  }

  const account = await findAccountById(accountId);
  if (!account) {
    const err = new Error('Rainforest business account not found.');
    err.statusCode = 404;
    throw err;
  }

  assertRainforestMerchantAccess(account, { businessId, userId });
  await syncRainforestAccountFromRemote(account);
  const refreshed = await findAccountById(accountId);

  if (!refreshed?.merchantId || !refreshed?.merchantApplicationId) {
    const err = new Error('Rainforest merchant application is not available yet.');
    err.statusCode = 400;
    throw err;
  }

  if (refreshed.onboardingStatus === MERCHANT_ONBOARDING_STATUS.ACTIVE) {
    return sanitizeMerchantRecord(refreshed);
  }

  const applicationStatus = String(refreshed.applicationStatus || '').toUpperCase();
  if (
    applicationStatus !== 'PROCESSING'
    && refreshed.onboardingStatus !== MERCHANT_ONBOARDING_STATUS.PROCESSING
  ) {
    const err = new Error(
      'Submit the Rainforest merchant application first. Sandbox approval simulation requires application status Processing.'
    );
    err.statusCode = 400;
    throw err;
  }

  await client.simulateMerchantApplication(
    refreshed.merchantId,
    refreshed.merchantApplicationId,
    { status: 'COMPLETED' }
  );

  await syncRainforestAccountFromRemote(refreshed);
  const finalAccount = await findAccountById(accountId);
  const sanitized = sanitizeMerchantRecord(finalAccount);

  auditRainforest({
    event: AUDIT_EVENTS.MERCHANT_STATUS_UPDATED,
    entity: 'RainforestAccount',
    entityId: finalAccount._id,
    createdBy: userId,
    after: { ...sanitized, action: 'simulate_sandbox_approval' },
    req,
  });

  return sanitized;
}

module.exports = {
  initializeMerchantOnboarding,
  getMerchantOnboardingStatus,
  listMerchantAccounts,
  findAccountById,
  findAccountByMerchantId,
  applyMerchantWebhookUpdate,
  applyMerchantApplicationWebhookUpdate,
  simulateSandboxMerchantApproval,
  sanitizeMerchantRecord,
  ensureRainforestEnabled,
  assertRainforestMerchantAccess,
  syncRainforestAccountFromRemote,
};
