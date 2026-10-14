'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const PayloadAccount = require('../model/payloadAccount.model');
const { PayloadClient } = require('../client/payload.client');
const {
  MERCHANT_ONBOARDING_STATUS,
  MERCHANT_STATUS,
  AUDIT_EVENTS,
  ENTITY_TYPE,
} = require('../constants/payload.constants');
const {
  mapPayloadMerchantStatus,
  mapPayloadProcessingStatus,
  merchantStatusLabel,
} = require('../utils/payloadStatus.util');
const { auditPayload } = require('./payloadAudit.helper');
const {
  assertAccountAccess,
  resolveHoaBoardEntityId,
  isHoaBoardAccount,
} = require('../../../account/service/accountAccess.helper');
const { toUserFriendlyPayloadMessage } = require('../utils/payloadUserError.util');
const { pickPlatformId } = require('../utils/payloadPlatform.util');
const payloadConfig = require('../../../../../../config/payload.config');
const logger = require('../../../../../../common/logger');

const client = new PayloadClient();

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function ensurePayloadEnabled() {
  if (!payloadConfig.payload.enabled) {
    const err = new Error('Payload payments are not enabled for this environment.');
    err.statusCode = 503;
    throw err;
  }
  if (!client.isConfigured()) {
    const err = new Error('Payload is not configured. Contact support.');
    err.statusCode = 503;
    throw err;
  }
}

function assertPayloadMerchantAccess(account, { businessId, userId }) {
  if (!account || account.isDeleted) {
    const err = new Error('Business account not found.');
    err.statusCode = 404;
    throw err;
  }

  if (account.entityType === ENTITY_TYPE.VENDOR) {
    // Vendor Processing Accounts are strictly owned by the Vendor user who created them.
    if (userId && account.createdBy && String(account.createdBy) === String(userId)) return;
    if (userId && account.entityId && String(account.entityId) === String(userId)) return;
    const err = new Error('You do not have permission to manage this Vendor Payload account.');
    err.statusCode = 403;
    throw err;
  }

  if (account.entityType === ENTITY_TYPE.HOA) {
    if (userId && account.createdBy && String(account.createdBy) === String(userId)) return;
    if (businessId && String(account.businessId) === String(businessId)) return;
  }

  assertAccountAccess(account, { businessId, userId });
}

function assertVendorMerchantFeatureEnabled() {
  if (!payloadConfig.payload.vendorMerchantEnabled) {
    const err = new Error('Vendor Payload merchant onboarding is not enabled.');
    err.statusCode = 403;
    err.code = 'VENDOR_MERCHANT_DISABLED';
    throw err;
  }
}

/**
 * Normalize role from Express req or user-like object.
 */
function resolveActorRoleKey(reqOrUser) {
  const roleRaw = reqOrUser?.userRoleName
    || reqOrUser?.user?.role?.name
    || reqOrUser?.user?.role
    || reqOrUser?.role?.name
    || reqOrUser?.role
    || reqOrUser?.roleName
    || '';
  return String(roleRaw).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function isVendorRoleActor(reqOrUser) {
  return resolveActorRoleKey(reqOrUser) === 'vendor';
}

/**
 * Vendor portal actors may manage Vendor Payload accounts.
 * Admins/superadmins are allowed for support; other roles are denied.
 * Accepts either a user-like object or Express req (for userRoleName).
 */
function assertVendorMerchantActor(reqOrUser) {
  const role = resolveActorRoleKey(reqOrUser);
  if (role === 'vendor' || role === 'admin' || role === 'superadmin') {
    return;
  }
  const err = new Error('Only Vendor users can manage Vendor Payload accounts.');
  err.statusCode = 403;
  throw err;
}

/**
 * Vendor Settings must never create HOA Processing Accounts.
 * Mis-routed UI historically sent entityType=hoa for Vendor actors; reject that path.
 */
function assertVendorActorDoesNotCreateHoaMerchant(entityType, reqOrUser) {
  if (entityType !== ENTITY_TYPE.HOA) return;
  if (!isVendorRoleActor(reqOrUser)) return;
  const err = new Error(
    'Vendor users must create a Vendor Payload Processing Account (entityType=vendor), not an HOA merchant.',
  );
  err.statusCode = 400;
  err.code = 'VENDOR_MUST_USE_VENDOR_ENTITY';
  throw err;
}

function resolvePayloadOwnership({ entityType, clientEntityId, userId, businessId }) {
  if (entityType === ENTITY_TYPE.VENDOR) {
    const vendorOid = toObjectId(userId);
    if (!vendorOid) {
      const err = new Error('Authentication required to create a Vendor Payload account.');
      err.statusCode = 401;
      throw err;
    }
    // businessId falls back to vendor user id when the Vendor has no company.
    const businessOid = toObjectId(businessId) || vendorOid;
    return {
      businessId: businessOid,
      entityId: vendorOid,
      metadata: { vendorUserId: String(vendorOid) },
    };
  }

  const businessOid = toObjectId(businessId);
  if (!businessOid) {
    const err = new Error('A company association is required to create a Payload business account.');
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
  // One Processing Account mapping per Vendor user (stable external id).
  if (entityType === ENTITY_TYPE.VENDOR && createdBy) {
    return `payload_vendor_${String(createdBy)}`;
  }
  if (entityType === ENTITY_TYPE.HOA && metadata?.hoaId && createdBy) {
    return `payload_${entityType}_${String(createdBy)}_${String(metadata.hoaId)}_${String(entityId)}`;
  }
  return `payload_${entityType}_${String(entityId)}`;
}

async function findExistingVendorPayloadAccount(vendorUserId) {
  const oid = toObjectId(vendorUserId);
  if (!oid) return null;
  const vendorKey = String(oid);
  return PayloadAccount.findOne({
    entityType: ENTITY_TYPE.VENDOR,
    isDeleted: { $ne: true },
    $or: [
      { createdBy: oid },
      { entityId: oid },
      { externalId: `payload_vendor_${vendorKey}` },
      { 'metadata.vendorUserId': vendorKey },
    ],
  });
}

function buildPayloadMerchantName(accountName, externalId) {
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
  return PayloadAccount.findOne({ _id: oid, isDeleted: { $ne: true } });
}

async function syncPayloadAccountFromRemote(account) {
  if (!account?.merchantId) return account;

  try {
    const remote = await client.getProcessingAccount(account.merchantId);
    const processingStatus = String(remote?.status || remote?.processing?.status || '').toLowerCase();
    const sandboxSimulated = account.metadata?.payloadSandboxSimulatedActive === true;
    const payloadReportsActive = processingStatus === 'active';

    account.merchantStatus = processingStatus || account.merchantStatus;
    account.applicationStatus = processingStatus || account.applicationStatus;
    account.onboardingStatus = payloadReportsActive
      ? MERCHANT_ONBOARDING_STATUS.ACTIVE
      : (sandboxSimulated && payloadConfig.isPayloadSandbox()
        ? MERCHANT_ONBOARDING_STATUS.ACTIVE
        : mapPayloadProcessingStatus(processingStatus));
    account.metadata = {
      ...(account.metadata || {}),
      payloadRemoteStatus: processingStatus || account.metadata?.payloadRemoteStatus || '',
      ...(payloadReportsActive ? { payloadSandboxSimulatedActive: false } : {}),
      payloadApplicationLink: remote?.application_link?.url || account.metadata?.payloadApplicationLink || '',
      payloadLegalEntityId: remote?.legal_entity_id || account.metadata?.payloadLegalEntityId || '',
    };

    account.lastSyncedAt = ClockService.now();
    await account.save();
  } catch (syncErr) {
    logger.warn('[PayloadMerchant] Remote sync failed', {
      merchantId: account.merchantId,
      message: syncErr.message,
    });
  }

  return account;
}

async function listMerchantAccounts({ entityType, businessId, createdBy, hoaId } = {}) {
  const query = { isDeleted: { $ne: true } };

  if (entityType === ENTITY_TYPE.VENDOR && createdBy) {
    query.entityType = ENTITY_TYPE.VENDOR;
    query.createdBy = toObjectId(createdBy);
  } else if (entityType === ENTITY_TYPE.HOA && createdBy) {
    query.entityType = ENTITY_TYPE.HOA;
    query.createdBy = toObjectId(createdBy);
    if (hoaId) query['metadata.hoaId'] = String(hoaId);
  } else {
    if (businessId) query.businessId = toObjectId(businessId);
    else if (createdBy) query.createdBy = toObjectId(createdBy);
    if (entityType) query.entityType = entityType;
  }

  const rows = await PayloadAccount.find(query).sort({ createdAt: -1 });
  await Promise.all(rows.map((account) => syncPayloadAccountFromRemote(account)));
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
  ensurePayloadEnabled();

  const userOid = toObjectId(createdBy);
  const displayName = String(accountName || merchantName || '').trim();
  if (!displayName) {
    const err = new Error('Business name is required to create a Payload merchant account.');
    err.statusCode = 400;
    throw err;
  }

  if (entityType === ENTITY_TYPE.VENDOR) {
    assertVendorMerchantFeatureEnabled();
    assertVendorMerchantActor(req || { role: 'vendor', _id: createdBy });
    const existing = await findExistingVendorPayloadAccount(createdBy);
    if (existing) {
      // Primary duplicate-onboarding prevention: never create a second Vendor PA mapping.
      await syncPayloadAccountFromRemote(existing);
      const sanitized = sanitizeMerchantRecord(existing);
      const awaiting = existing.metadata?.awaitingPayloadProcessingAccount || !sanitized.merchantId;
      return {
        account: sanitized,
        onboardingMode: awaiting ? 'plugin' : 'api',
        requiresPayloadProcessingAccount: awaiting,
        alreadyExists: true,
      };
    }
  }

  // Defense: Vendor actors must not create HOA merchants (wrong Settings route historically did this).
  assertVendorActorDoesNotCreateHoaMerchant(entityType, req);

  const ownership = resolvePayloadOwnership({
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
  const payloadName = buildPayloadMerchantName(displayName, externalId);
  const idempotencyKey = crypto.createHash('sha256').update(externalId).digest('hex').slice(0, 40);

  const payloadPayload = {
    name: payloadName,
    application_link: true,
    attrs: {
      propmv_external_id: externalId,
      propmv_entity_type: entityType,
      propmv_entity_id: String(ownership.entityId),
      propmv_business_id: String(ownership.businessId),
      propmv_account_name: displayName,
      ...(ownership.metadata?.hoaId ? { propmv_hoa_id: String(ownership.metadata.hoaId) } : {}),
    },
  };

  if (payloadConfig.payload.orgProcessingId) {
    payloadPayload.parent_org_id = payloadConfig.payload.orgProcessingId;
  }

  const onboardingMode = payloadConfig.payload.merchantOnboardingMode || 'auto';
  let created = null;
  let pluginOnboarding = onboardingMode === 'plugin';

  if (onboardingMode === 'plugin') {
    logger.info('[PayloadMerchant] Plugin onboarding mode - processing account will be created in Payload via ProcessingAccount embed');
  } else {
    try {
      created = await client.createProcessingAccount(payloadPayload, { idempotencyKey });
    } catch (err) {
      const status = err.statusCode || 500;
      if (onboardingMode === 'auto' && (status === 403 || status === 401)) {
        pluginOnboarding = true;
        logger.warn('[PayloadMerchant] Server-side processing account create unavailable; using ProcessingAccount plugin', {
          status,
          message: err.message,
        });
      } else {
        err.message = toUserFriendlyPayloadMessage(status, err.message);
        throw err;
      }
    }
  }

  // Use null (not '') when plugin onboarding has not yet minted a processing account id.
  // Empty-string merchantId breaks Atlas unique sparse index provider+merchantId.
  const merchantId = created?.id || created?.processing_id || null;
  const merchantApplicationId = created?.application_link?.id || null;
  const merchantStatus = created
    ? String(created?.status || MERCHANT_STATUS.PENDING).toUpperCase()
    : MERCHANT_STATUS.PENDING;
  const applicationStatus = merchantStatus;
  const onboardingStatus = created
    ? mapPayloadProcessingStatus(created?.status)
    : MERCHANT_ONBOARDING_STATUS.NOT_STARTED;
  const applicationLinkUrl = created?.application_link?.url || '';

  let account;
  try {
    account = await PayloadAccount.create({
      businessId: ownership.businessId,
      entityType,
      entityId: ownership.entityId,
      externalId,
      accountName: displayName,
      merchantId,
      merchantApplicationId,
      merchantName: payloadName,
      merchantStatus,
      applicationStatus,
      onboardingStatus,
      metadata: {
        ...ownership.metadata,
        ...(applicationLinkUrl ? { payloadApplicationLink: applicationLinkUrl } : {}),
        ...(pluginOnboarding ? { payloadPluginOnboarding: true, awaitingPayloadProcessingAccount: true } : {}),
      },
      environment: payloadConfig.payload.environment,
      lastSyncedAt: ClockService.now(),
      createdBy: userOid,
      updatedBy: userOid,
    });
  } catch (createErr) {
    if (createErr?.code === 11000) {
      account = await PayloadAccount.findOne({ externalId, isDeleted: { $ne: true } });
      if (account) {
        const sanitized = sanitizeMerchantRecord(account);
        const awaiting = account.metadata?.awaitingPayloadProcessingAccount || !sanitized.merchantId;
        return {
          account: sanitized,
          onboardingMode: awaiting ? 'plugin' : 'api',
          requiresPayloadProcessingAccount: awaiting,
        };
      }
    }
    throw createErr;
  }

  auditPayload({
    event: AUDIT_EVENTS.MERCHANT_CREATED,
    entity: 'PayloadAccount',
    entityId: account._id,
    createdBy,
    after: sanitizeMerchantRecord(account),
    req,
  });

  const sanitized = sanitizeMerchantRecord(account);
  return {
    account: sanitized,
    onboardingMode: pluginOnboarding ? 'plugin' : 'api',
    requiresPayloadProcessingAccount: pluginOnboarding || !sanitized.merchantId,
    alreadyExists: false,
  };
}

async function getMerchantOnboardingStatus({ accountId, businessId, userId }) {
  ensurePayloadEnabled();
  const account = await findAccountById(accountId);
  if (!account) {
    const err = new Error('Payload business account not found.');
    err.statusCode = 404;
    throw err;
  }

  assertPayloadMerchantAccess(account, { businessId, userId });

  await syncPayloadAccountFromRemote(account);

  return sanitizeMerchantRecord(account);
}

async function findAccountByMerchantId(merchantId) {
  if (!merchantId) return null;
  return PayloadAccount.findOne({ merchantId: String(merchantId), isDeleted: { $ne: true } });
}

async function applyMerchantWebhookUpdate({ merchantId, merchantStatus, applicationStatus, webhookAt = null }) {
  const account = await findAccountByMerchantId(merchantId);
  if (!account) return null;

  const before = sanitizeMerchantRecord(account);
  let processingStatus = String(merchantStatus || applicationStatus || account.merchantStatus || '').toLowerCase();

  if (account.merchantId) {
    try {
      const remote = await client.getProcessingAccount(account.merchantId);
      if (remote?.status) processingStatus = String(remote.status).toLowerCase();
    } catch (err) {
      logger.warn('[PayloadMerchant] Webhook processing account re-fetch failed', {
        merchantId: account.merchantId,
        message: err.message,
      });
    }
  }

  account.merchantStatus = processingStatus || account.merchantStatus;
  account.applicationStatus = processingStatus || account.applicationStatus;
  account.onboardingStatus = mapPayloadProcessingStatus(processingStatus);
  account.metadata = {
    ...(account.metadata || {}),
    payloadRemoteStatus: processingStatus,
    ...(processingStatus === 'active' ? { payloadSandboxSimulatedActive: false } : {}),
  };
  account.lastWebhookAt = webhookAt || ClockService.now();
  account.lastSyncedAt = ClockService.now();
  await account.save();

  auditPayload({
    event: AUDIT_EVENTS.MERCHANT_STATUS_UPDATED,
    entity: 'PayloadAccount',
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
  account.onboardingStatus = mapPayloadMerchantStatus(account.merchantStatus, account.applicationStatus);
  account.lastWebhookAt = webhookAt || ClockService.now();
  account.lastSyncedAt = ClockService.now();
  await account.save();

  auditPayload({
    event: AUDIT_EVENTS.MERCHANT_STATUS_UPDATED,
    entity: 'PayloadAccount',
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
  ensurePayloadEnabled();
  if (!payloadConfig.isPayloadSandbox()) {
    const err = new Error('Merchant approval simulation is only available in Payload sandbox.');
    err.statusCode = 400;
    throw err;
  }

  const account = await findAccountById(accountId);
  if (!account) {
    const err = new Error('Payload business account not found.');
    err.statusCode = 404;
    throw err;
  }

  assertPayloadMerchantAccess(account, { businessId, userId });
  await syncPayloadAccountFromRemote(account);
  const refreshed = await findAccountById(accountId);

  if (!refreshed?.merchantId) {
    const err = new Error(
      'Link a Payload processing account first (finish the embedded form or register the processing account id).'
    );
    err.statusCode = 400;
    throw err;
  }

  if (refreshed.onboardingStatus === MERCHANT_ONBOARDING_STATUS.ACTIVE) {
    return sanitizeMerchantRecord(refreshed);
  }

  const remoteAfterSimulate = await client.simulateSandboxProcessingActivation(refreshed.merchantId);
  const payloadReportsActive = String(remoteAfterSimulate?.status || '').toLowerCase() === 'active';

  const accountDoc = await findAccountById(accountId);
  accountDoc.metadata = {
    ...(accountDoc.metadata || {}),
    payloadSandboxSimulatedActive: true,
    payloadRemoteStatus: remoteAfterSimulate?.status || accountDoc.metadata?.payloadRemoteStatus || '',
    payloadSandboxSimulatedAt: ClockService.now(),
  };

  if (payloadReportsActive) {
    accountDoc.merchantStatus = 'ACTIVE';
    accountDoc.applicationStatus = 'ACTIVE';
    accountDoc.onboardingStatus = MERCHANT_ONBOARDING_STATUS.ACTIVE;
  } else {
    // Payload sandbox may keep status as pending until their backend approves; PropMv treats simulate as active for testing.
    accountDoc.merchantStatus = String(remoteAfterSimulate?.status || accountDoc.merchantStatus || 'pending');
    accountDoc.applicationStatus = accountDoc.merchantStatus;
    accountDoc.onboardingStatus = MERCHANT_ONBOARDING_STATUS.ACTIVE;
  }

  accountDoc.lastSyncedAt = ClockService.now();
  await accountDoc.save();

  await syncPayloadAccountFromRemote(accountDoc);

  try {
    const { syncDepositMethodsForAccount } = require('./payloadDepositMethod.service');
    await syncDepositMethodsForAccount({ accountId, businessId, userId, req });
  } catch (syncErr) {
    logger.warn('[PayloadMerchant] Deposit bank sync after simulate failed', {
      accountId,
      message: syncErr.message,
    });
  }

  const finalAccount = await findAccountById(accountId);
  if (finalAccount && !payloadReportsActive) {
    finalAccount.onboardingStatus = MERCHANT_ONBOARDING_STATUS.ACTIVE;
    finalAccount.metadata = {
      ...(finalAccount.metadata || {}),
      payloadSandboxSimulatedActive: true,
    };
    await finalAccount.save();
  }

  const sanitized = sanitizeMerchantRecord(finalAccount);
  const payloadRemoteStatus = String(
    finalAccount?.metadata?.payloadRemoteStatus || remoteAfterSimulate?.status || ''
  ).toLowerCase();

  auditPayload({
    event: AUDIT_EVENTS.MERCHANT_STATUS_UPDATED,
    entity: 'PayloadAccount',
    entityId: finalAccount._id,
    createdBy: userId,
    after: {
      ...sanitized,
      action: 'simulate_sandbox_processing_activation',
      payloadRemoteStatus,
      payloadDashboardActive: payloadRemoteStatus === 'active',
    },
    req,
  });

  return {
    ...sanitized,
    payloadRemoteStatus,
    payloadDashboardActive: payloadRemoteStatus === 'active',
  };
}

async function registerMerchantFromProcessingAccount({
  accountId,
  processingAccountId,
  businessId,
  userId,
  req = null,
}) {
  ensurePayloadEnabled();

  const processingId = String(processingAccountId || '').trim();
  if (!processingId) {
    const err = new Error('Processing account id is required.');
    err.statusCode = 400;
    throw err;
  }

  const account = await findAccountById(accountId);
  if (!account) {
    const err = new Error('Payload business account not found.');
    err.statusCode = 404;
    throw err;
  }

  assertPayloadMerchantAccess(account, { businessId, userId });

  let remote = null;
  try {
    remote = await client.getProcessingAccount(processingId);
  } catch (syncErr) {
    logger.warn('[PayloadMerchant] Processing account lookup failed during register', {
      processingAccountId: processingId,
      message: syncErr.message,
    });
  }

  const before = sanitizeMerchantRecord(account);
  account.merchantId = processingId;
  account.merchantApplicationId =
    remote?.application_link?.id
    || remote?.latest_merchant_application?.id
    || account.merchantApplicationId
    || '';
  if (remote?.status) {
    account.merchantStatus = String(remote.status).toUpperCase();
    account.applicationStatus = account.merchantStatus;
    account.onboardingStatus = mapPayloadProcessingStatus(remote.status);
  } else if (!account.merchantId) {
    account.onboardingStatus = MERCHANT_ONBOARDING_STATUS.PROCESSING;
  }
  account.metadata = {
    ...(account.metadata || {}),
    payloadPluginOnboarding: false,
    awaitingPayloadProcessingAccount: false,
    ...(remote?.application_link?.url
      ? { payloadApplicationLink: remote.application_link.url }
      : {}),
  };
  account.lastSyncedAt = ClockService.now();
  await account.save();
  await syncPayloadAccountFromRemote(account);

  try {
    const { syncDepositMethodsForAccount } = require('./payloadDepositMethod.service');
    await syncDepositMethodsForAccount({ accountId, businessId, userId, req });
  } catch (syncErr) {
    logger.warn('[PayloadMerchant] Deposit bank sync after register failed', {
      accountId,
      message: syncErr.message,
    });
  }

  auditPayload({
    event: AUDIT_EVENTS.MERCHANT_CREATED,
    entity: 'PayloadAccount',
    entityId: account._id,
    createdBy: userId,
    before,
    after: sanitizeMerchantRecord(account),
    req,
  });

  return sanitizeMerchantRecord(await findAccountById(account._id));
}

module.exports = {
  initializeMerchantOnboarding,
  registerMerchantFromProcessingAccount,
  getMerchantOnboardingStatus,
  listMerchantAccounts,
  findAccountById,
  findAccountByMerchantId,
  applyMerchantWebhookUpdate,
  applyMerchantApplicationWebhookUpdate,
  simulateSandboxMerchantApproval,
  sanitizeMerchantRecord,
  ensurePayloadEnabled,
  assertPayloadMerchantAccess,
  assertVendorMerchantFeatureEnabled,
  assertVendorMerchantActor,
  assertVendorActorDoesNotCreateHoaMerchant,
  findExistingVendorPayloadAccount,
  resolvePayloadOwnership,
  buildExternalId,
  syncPayloadAccountFromRemote,
};
