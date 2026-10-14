'use strict';

const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const {
  RainforestDepositMethod,
  DEPOSIT_ROUTE_TYPE,
  DEPOSIT_METHOD_STATUS,
  DEPOSIT_METHOD_TYPE,
} = require('../model/rainforestDepositMethod.model');
const { RainforestClient } = require('../client/rainforest.client');
const {
  AUDIT_EVENTS,
  DEPOSIT_ROUTE_KEYS,
} = require('../constants/rainforest.constants');
const {
  findAccountById,
  assertRainforestMerchantAccess,
  ensureRainforestEnabled,
  sanitizeMerchantRecord,
  syncRainforestAccountFromRemote,
} = require('./rainforestMerchant.service');
const {
  createMerchantHubSession,
  createMerchantOnboardingSession,
} = require('./rainforestComponentSession.service');
const {
  resolveDepositBankSetupFlow,
  depositBankBlockedReason,
} = require('../utils/rainforestStatus.util');
const { auditRainforest } = require('./rainforestAudit.helper');
const rainforestConfig = require('../../../../../../config/rainforest.config');
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
  return raw || 'unknown';
}

function extractAchDisplay(remote = {}) {
  const ach = remote?.ach || remote?.plaid_ach || {};
  const billing = remote?.billing_contact || {};
  return {
    holderName: billing?.name || '',
    last4: ach?.account_number_last_4 || ach?.last4 || '',
    routingNumber: ach?.routing_number || '',
    bankName: ach?.bank_name || '',
    accountType: normalizeAccountType(ach?.account_type || ach?.accountType),
  };
}

function resolveRouteFlags(depositMethodId, depositRoutes = {}) {
  const routes = depositRoutes && typeof depositRoutes === 'object' ? depositRoutes : {};
  const assignedRoutes = [];
  let isPrimaryPayout = false;

  Object.entries(routes).forEach(([routeKey, routeVal]) => {
    const routeId = routeVal?.deposit_method_id || routeVal?.depositMethodId || '';
    if (routeId && String(routeId) === String(depositMethodId)) {
      assignedRoutes.push(String(routeKey).toUpperCase());
      if (String(routeKey).toUpperCase() === DEPOSIT_ROUTE_KEYS.PAYMENTS) {
        isPrimaryPayout = true;
      }
    }
  });

  const routeType = assignedRoutes.includes(DEPOSIT_ROUTE_KEYS.PAYMENTS)
    ? DEPOSIT_ROUTE_TYPE.PAYMENTS
    : assignedRoutes.includes(DEPOSIT_ROUTE_KEYS.BILLING)
      ? DEPOSIT_ROUTE_TYPE.BILLING
      : DEPOSIT_ROUTE_TYPE.AVAILABLE;

  return { routeType, isPrimaryPayout, assignedRoutes };
}

function sanitizeDepositMethodRecord(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(row._id),
    rainforestAccountId: String(row.rainforestAccountRef),
    merchantId: row.merchantId || '',
    depositMethodId: row.depositMethodId || '',
    depositMethodConfigId: row.depositMethodConfigId || '',
    routeType: row.routeType || DEPOSIT_ROUTE_TYPE.AVAILABLE,
    isPrimary: !!row.isPrimaryPayout,
    isPrimaryPayout: !!row.isPrimaryPayout,
    status: row.status || '',
    methodType: row.methodType || '',
    holderName: row.holderName || '',
    routingNumber: row.routingNumber || '',
    last4: row.last4 || '',
    bankName: row.bankName || '',
    accountType: row.accountType || 'unknown',
    fingerprint: row.fingerprint || '',
    lastSyncedAt: row.lastSyncedAt || null,
    lastWebhookAt: row.lastWebhookAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

async function loadAccountWithAccess({ accountId, businessId, userId }) {
  ensureRainforestEnabled();
  const account = await findAccountById(accountId);
  if (!account) {
    const err = new Error('Rainforest business account not found.');
    err.statusCode = 404;
    throw err;
  }
  assertRainforestMerchantAccess(account, { businessId, userId });
  if (!account.merchantId) {
    const err = new Error('Rainforest merchant is not initialized for this business account.');
    err.statusCode = 400;
    throw err;
  }
  return account;
}

async function upsertDepositMethodFromRemote({
  account,
  remote,
  depositRoutes,
  webhookAt = null,
  createdBy = null,
}) {
  const depositMethodId = remote?.deposit_method_id || remote?.depositMethodId || '';
  if (!depositMethodId) return null;

  const display = extractAchDisplay(remote);
  const { routeType, isPrimaryPayout } = resolveRouteFlags(depositMethodId, depositRoutes);
  const methodType = String(remote?.method_type || remote?.methodType || DEPOSIT_METHOD_TYPE.ACH).toUpperCase();

  let doc = await RainforestDepositMethod.findOne({
    depositMethodId: String(depositMethodId),
    isDeleted: { $ne: true },
  });

  const before = doc ? sanitizeDepositMethodRecord(doc) : null;
  const payload = {
    provider: account.provider,
    rainforestAccountRef: account._id,
    businessId: account.businessId,
    entityType: account.entityType,
    entityId: account.entityId,
    merchantId: account.merchantId,
    depositMethodId: String(depositMethodId),
    depositMethodConfigId: remote?.deposit_method_config_id || remote?.depositMethodConfigId || '',
    routeType,
    isPrimaryPayout,
    status: String(remote?.status || DEPOSIT_METHOD_STATUS.CREATED).toUpperCase(),
    methodType: Object.values(DEPOSIT_METHOD_TYPE).includes(methodType) ? methodType : DEPOSIT_METHOD_TYPE.ACH,
    holderName: display.holderName,
    routingNumber: display.routingNumber,
    last4: display.last4,
    bankName: display.bankName,
    accountType: display.accountType,
    fingerprint: remote?.fingerprint || '',
    latestResponse: remote,
    lastSyncedAt: ClockService.now(),
    ...(webhookAt ? { lastWebhookAt: webhookAt } : {}),
    updatedBy: createdBy ? toObjectId(createdBy) : undefined,
  };

  if (!doc) {
    doc = await RainforestDepositMethod.create({
      ...payload,
      createdBy: createdBy ? toObjectId(createdBy) : null,
    });
    auditRainforest({
      event: AUDIT_EVENTS.DEPOSIT_METHOD_ADDED,
      entity: 'RainforestDepositMethod',
      entityId: doc._id,
      createdBy,
      after: sanitizeDepositMethodRecord(doc),
    });
    return doc;
  }

  Object.assign(doc, payload);
  await doc.save();

  auditRainforest({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_SYNCED,
    entity: 'RainforestDepositMethod',
    entityId: doc._id,
    before,
    after: sanitizeDepositMethodRecord(doc),
  });

  return doc;
}

async function reconcilePrimaryFlags(accountRef, depositRoutes = {}) {
  const paymentsRouteId =
    depositRoutes?.PAYMENTS?.deposit_method_id
    || depositRoutes?.PAYMENTS?.depositMethodId
    || '';

  await RainforestDepositMethod.updateMany(
    { rainforestAccountRef: accountRef, isDeleted: { $ne: true } },
    { $set: { isPrimaryPayout: false } }
  );

  if (paymentsRouteId) {
    await RainforestDepositMethod.updateMany(
      {
        rainforestAccountRef: accountRef,
        depositMethodId: String(paymentsRouteId),
        isDeleted: { $ne: true },
      },
      { $set: { isPrimaryPayout: true, routeType: DEPOSIT_ROUTE_TYPE.PAYMENTS } }
    );
  }
}

function collectDepositMethodIdsFromSource(source = {}) {
  const ids = new Set();
  const routes = source?.deposit_routes || {};
  Object.values(routes).forEach((route) => {
    const id = route?.deposit_method_id || route?.depositMethodId;
    if (id) ids.add(String(id));
  });
  const singleId = source?.deposit_payment_method_id || source?.depositPaymentMethodId;
  if (singleId) ids.add(String(singleId));
  (source?.available_deposit_method_ids || []).forEach((id) => {
    if (id) ids.add(String(id));
  });
  return ids;
}

function collectDepositMethodIds(remoteMerchant = {}, remoteApplication = null) {
  const ids = new Set(collectDepositMethodIdsFromSource(remoteMerchant));
  if (remoteApplication) {
    collectDepositMethodIdsFromSource(remoteApplication).forEach((id) => ids.add(id));
  }
  return [...ids];
}

function mergeDepositRoutes(primary = {}, fallback = {}) {
  return { ...(fallback || {}), ...(primary || {}) };
}

async function resolveDepositSyncContext(account, remoteMerchant) {
  const applicationStub = remoteMerchant?.latest_merchant_application || {};
  const merchantApplicationId =
    applicationStub?.merchant_application_id || account.merchantApplicationId || '';

  let depositRoutes = { ...(remoteMerchant?.deposit_routes || {}) };
  let ids = collectDepositMethodIds(remoteMerchant, applicationStub);
  let application = applicationStub;

  const needsApplicationFetch =
    !!merchantApplicationId
    && (
      !ids.length
      || !depositRoutes?.PAYMENTS?.deposit_method_id
      || !depositRoutes?.PAYMENTS?.depositMethodId
    );

  if (needsApplicationFetch) {
    try {
      application = await client.getMerchantApplication(account.merchantId, merchantApplicationId);
      ids = collectDepositMethodIds(remoteMerchant, application);
      depositRoutes = mergeDepositRoutes(depositRoutes, application?.deposit_routes || {});
    } catch (err) {
      logger.warn('[RainforestDepositMethod] Application sync fetch failed', {
        merchantApplicationId,
        message: err.message,
      });
    }
  }

  return { depositRoutes, ids, application };
}

async function syncDepositMethodsForAccount({
  accountId,
  businessId,
  userId,
  req = null,
}) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  const remote = await client.getMerchant(account.merchantId);

  const application = remote?.latest_merchant_application || {};
  account.merchantApplicationId =
    application?.merchant_application_id || account.merchantApplicationId;
  account.merchantStatus = String(remote?.status || account.merchantStatus).toUpperCase();
  account.applicationStatus = String(application?.status || account.applicationStatus).toUpperCase();
  account.lastSyncedAt = ClockService.now();
  await account.save();

  const { depositRoutes, ids } = await resolveDepositSyncContext(account, remote);
  const synced = [];

  for (const depositMethodId of ids) {
    try {
      const remoteMethod = await client.getDepositMethod(depositMethodId);
      const doc = await upsertDepositMethodFromRemote({
        account,
        remote: remoteMethod,
        depositRoutes,
        createdBy: userId,
      });
      if (doc) synced.push(sanitizeDepositMethodRecord(doc));
    } catch (err) {
      logger.warn('[RainforestDepositMethod] Sync fetch failed', {
        depositMethodId,
        message: err.message,
      });
    }
  }

  await reconcilePrimaryFlags(account._id, depositRoutes);

  auditRainforest({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_SYNCED,
    entity: 'RainforestAccount',
    entityId: account._id,
    createdBy: userId,
    after: { accountId: String(account._id), count: synced.length },
    req,
  });

  return synced;
}

async function listDepositMethodsForAccount({ accountId, businessId, userId }) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  let rows = await RainforestDepositMethod.find({
    rainforestAccountRef: account._id,
    isDeleted: { $ne: true },
  }).sort({ isPrimaryPayout: -1, createdAt: -1 });

  if (!rows.length) {
    await syncDepositMethodsForAccount({ accountId, businessId, userId });
    rows = await RainforestDepositMethod.find({
      rainforestAccountRef: account._id,
      isDeleted: { $ne: true },
    }).sort({ isPrimaryPayout: -1, createdAt: -1 });
  }

  return rows.map(sanitizeDepositMethodRecord);
}

async function getMerchantDetail({ accountId, businessId, userId }) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  await syncRainforestAccountFromRemote(account);
  const refreshedAccount = await findAccountById(accountId);

  let remoteSummary = null;

  try {
    const remote = await client.getMerchant(refreshedAccount.merchantId);
    remoteSummary = {
      depositRoutes: remote?.deposit_routes || {},
      availableDepositMethodIds: remote?.available_deposit_method_ids || [],
      billingType: remote?.billing_type || '',
      depositFrequency: remote?.deposit_frequency || '',
    };
  } catch (err) {
    logger.warn('[RainforestDepositMethod] Merchant detail sync failed', {
      merchantId: refreshedAccount.merchantId,
      message: err.message,
    });
  }

  await syncDepositMethodsForAccount({ accountId, businessId, userId });
  const depositMethods = await RainforestDepositMethod.find({
    rainforestAccountRef: refreshedAccount._id,
    isDeleted: { $ne: true },
  }).sort({ isPrimaryPayout: -1, createdAt: -1 });

  return {
    account: sanitizeMerchantRecord(refreshedAccount),
    depositMethods: depositMethods.map(sanitizeDepositMethodRecord),
    remote: remoteSummary,
  };
}

async function initializeDepositMethodSetup({
  accountId,
  businessId,
  userId,
  req = null,
}) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  await syncRainforestAccountFromRemote(account);
  const refreshed = await findAccountById(accountId);

  if (!refreshed?.merchantId) {
    const err = new Error('Rainforest merchant is not initialized for this business account.');
    err.statusCode = 400;
    throw err;
  }

  let merchantApplicationId = refreshed.merchantApplicationId || '';
  if (!merchantApplicationId) {
    try {
      const remote = await client.getMerchant(refreshed.merchantId);
      merchantApplicationId =
        remote?.latest_merchant_application?.merchant_application_id || merchantApplicationId;
    } catch (err) {
      logger.warn('[RainforestDepositMethod] Merchant lookup failed during initialize', {
        merchantId: refreshed.merchantId,
        message: err.message,
      });
    }
  }

  const flow = resolveDepositBankSetupFlow(refreshed.onboardingStatus);
  const basePayload = {
    flow,
    accountId: String(refreshed._id),
    merchantId: refreshed.merchantId,
    merchantApplicationId: merchantApplicationId || refreshed.merchantApplicationId || '',
    merchantStatus: refreshed.merchantStatus || '',
    applicationStatus: refreshed.applicationStatus || '',
    onboardingStatus: refreshed.onboardingStatus || '',
    termsAndConditionsUrl: rainforestConfig.rainforest.termsAndConditionsUrl || '',
  };

  if (flow === 'blocked') {
    auditRainforest({
      event: AUDIT_EVENTS.DEPOSIT_METHOD_SYNCED,
      entity: 'RainforestAccount',
      entityId: refreshed._id,
      createdBy: userId,
      after: { flow, onboardingStatus: refreshed.onboardingStatus, action: 'deposit_bank_blocked' },
      req,
    });

    return {
      ...basePayload,
      blockedReason: depositBankBlockedReason(refreshed.onboardingStatus),
    };
  }

  if (flow === 'onboarding' && !merchantApplicationId) {
    const err = new Error(
      'Rainforest merchant application is not available yet. Complete merchant onboarding before adding deposit banks.'
    );
    err.statusCode = 400;
    throw err;
  }

  if (merchantApplicationId && merchantApplicationId !== refreshed.merchantApplicationId) {
    refreshed.merchantApplicationId = merchantApplicationId;
    await refreshed.save();
  }

  const session = flow === 'hub'
    ? await createMerchantHubSession({ merchantId: refreshed.merchantId })
    : await createMerchantOnboardingSession({ merchantId: refreshed.merchantId });

  auditRainforest({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_ADDED,
    entity: 'RainforestAccount',
    entityId: refreshed._id,
    createdBy: userId,
    after: {
      merchantApplicationId: basePayload.merchantApplicationId,
      flow,
      action: flow === 'hub' ? 'initialize_hub_session' : 'initialize_onboarding_session',
    },
    req,
  });

  return {
    ...basePayload,
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
  };
}

async function registerDepositMethodFromComponent({
  accountId,
  businessId,
  userId,
  depositMethodId,
  depositMethodConfigId,
  setAsPrimary = false,
  req = null,
}) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  if (!depositMethodId) {
    const err = new Error('Deposit method ID is required.');
    err.statusCode = 400;
    throw err;
  }

  const remoteMethod = await client.getDepositMethod(depositMethodId);
  const remoteMerchant = await client.getMerchant(account.merchantId);
  const depositRoutes = { ...(remoteMerchant?.deposit_routes || {}) };
  const availableIds = [...(remoteMerchant?.available_deposit_method_ids || [])];
  const merchantApplicationId =
    account.merchantApplicationId
    || remoteMerchant?.latest_merchant_application?.merchant_application_id
    || '';

  if (!availableIds.includes(depositMethodId)) {
    availableIds.push(depositMethodId);
  }

  const patchPayload = {
    available_deposit_method_ids: availableIds.filter(Boolean),
  };

  if (setAsPrimary) {
    patchPayload.deposit_routes = {
      ...depositRoutes,
      [DEPOSIT_ROUTE_KEYS.PAYMENTS]: {
        ...(depositRoutes?.PAYMENTS || {}),
        deposit_method_id: depositMethodId,
      },
    };
  }

  if (merchantApplicationId) {
    try {
      await client.patchMerchantApplication(account.merchantId, merchantApplicationId, patchPayload);
    } catch (patchErr) {
      logger.warn('[RainforestDepositMethod] Merchant application patch failed', {
        merchantId: account.merchantId,
        merchantApplicationId,
        message: patchErr.message,
      });
      if (setAsPrimary) throw patchErr;
    }
  }

  const refreshedMerchant = await client.getMerchant(account.merchantId);
  const doc = await upsertDepositMethodFromRemote({
    account,
    remote: {
      ...remoteMethod,
      deposit_method_config_id: depositMethodConfigId || remoteMethod?.deposit_method_config_id,
    },
    depositRoutes: refreshedMerchant?.deposit_routes || depositRoutes,
    createdBy: userId,
  });

  await reconcilePrimaryFlags(account._id, refreshedMerchant?.deposit_routes || depositRoutes);

  auditRainforest({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_ADDED,
    entity: 'RainforestDepositMethod',
    entityId: doc?._id,
    createdBy: userId,
    after: sanitizeDepositMethodRecord(doc),
    req,
  });

  return sanitizeDepositMethodRecord(doc);
}

async function setPrimaryDepositMethod({
  accountId,
  depositMethodLocalId,
  businessId,
  userId,
  req = null,
}) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  const bank = await RainforestDepositMethod.findOne({
    _id: toObjectId(depositMethodLocalId),
    rainforestAccountRef: account._id,
    isDeleted: { $ne: true },
  });

  if (!bank?.depositMethodId) {
    const err = new Error('Deposit bank account not found.');
    err.statusCode = 404;
    throw err;
  }

  const remoteMerchant = await client.getMerchant(account.merchantId);
  const merchantApplicationId =
    account.merchantApplicationId
    || remoteMerchant?.latest_merchant_application?.merchant_application_id
    || '';

  if (!merchantApplicationId) {
    const err = new Error('Rainforest merchant application is not available.');
    err.statusCode = 400;
    throw err;
  }

  const depositRoutes = { ...(remoteMerchant?.deposit_routes || {}) };
  depositRoutes[DEPOSIT_ROUTE_KEYS.PAYMENTS] = {
    ...(depositRoutes[DEPOSIT_ROUTE_KEYS.PAYMENTS] || {}),
    deposit_method_id: bank.depositMethodId,
  };

  const availableIds = [...(remoteMerchant?.available_deposit_method_ids || [])];
  if (!availableIds.includes(bank.depositMethodId)) {
    availableIds.push(bank.depositMethodId);
  }

  await client.patchMerchantApplication(account.merchantId, merchantApplicationId, {
    deposit_routes: depositRoutes,
    available_deposit_method_ids: availableIds.filter(Boolean),
  });

  const refreshedMerchant = await client.getMerchant(account.merchantId);
  const before = sanitizeDepositMethodRecord(bank);

  bank.isPrimaryPayout = true;
  bank.routeType = DEPOSIT_ROUTE_TYPE.PAYMENTS;
  bank.lastSyncedAt = ClockService.now();
  await bank.save();

  await reconcilePrimaryFlags(account._id, refreshedMerchant?.deposit_routes || depositRoutes);

  auditRainforest({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_PRIMARY_UPDATED,
    entity: 'RainforestDepositMethod',
    entityId: bank._id,
    createdBy: userId,
    before,
    after: sanitizeDepositMethodRecord(bank),
    req,
  });

  return sanitizeDepositMethodRecord(bank);
}

async function applyDepositMethodWebhookUpdate({
  depositMethodId,
  remotePayload,
  webhookAt = null,
}) {
  if (!depositMethodId) return null;

  const bank = await RainforestDepositMethod.findOne({
    depositMethodId: String(depositMethodId),
    isDeleted: { $ne: true },
  });
  if (!bank) return null;

  const RainforestAccount = require('../model/rainforestAccount.model');
  const account = await RainforestAccount.findById(bank.rainforestAccountRef);
  if (!account) return bank;

  let depositRoutes = {};
  try {
    const remoteMerchant = await client.getMerchant(account.merchantId);
    depositRoutes = remoteMerchant?.deposit_routes || {};
  } catch (err) {
    logger.warn('[RainforestDepositMethod] Webhook merchant fetch failed', { message: err.message });
  }

  return upsertDepositMethodFromRemote({
    account,
    remote: remotePayload || { deposit_method_id: depositMethodId },
    depositRoutes,
    webhookAt,
  });
}

async function syncDepositMethodsFromMerchantWebhook({ merchantId, remoteMerchant, webhookAt = null }) {
  const RainforestAccount = require('../model/rainforestAccount.model');
  const account = await RainforestAccount.findOne({ merchantId: String(merchantId), isDeleted: { $ne: true } });
  if (!account) return [];

  let remote = remoteMerchant;
  if (!remote?.deposit_routes && !remote?.latest_merchant_application) {
    try {
      remote = await client.getMerchant(account.merchantId);
    } catch (err) {
      logger.warn('[RainforestDepositMethod] Webhook merchant fetch failed', { message: err.message });
      remote = remoteMerchant || {};
    }
  }

  const { depositRoutes, ids } = await resolveDepositSyncContext(account, remote);
  const synced = [];

  for (const depositMethodId of ids) {
    try {
      const remoteMethod = await client.getDepositMethod(depositMethodId);
      const doc = await upsertDepositMethodFromRemote({
        account,
        remote: remoteMethod,
        depositRoutes,
        webhookAt,
      });
      if (doc) synced.push(doc);
    } catch (err) {
      logger.warn('[RainforestDepositMethod] Webhook sync fetch failed', {
        depositMethodId,
        message: err.message,
      });
    }
  }

  await reconcilePrimaryFlags(account._id, depositRoutes);
  return synced;
}

module.exports = {
  listDepositMethodsForAccount,
  syncDepositMethodsForAccount,
  getMerchantDetail,
  initializeDepositMethodSetup,
  registerDepositMethodFromComponent,
  setPrimaryDepositMethod,
  applyDepositMethodWebhookUpdate,
  syncDepositMethodsFromMerchantWebhook,
  sanitizeDepositMethodRecord,
  collectDepositMethodIds,
  collectDepositMethodIdsFromSource,
  resolveDepositSyncContext,
};
