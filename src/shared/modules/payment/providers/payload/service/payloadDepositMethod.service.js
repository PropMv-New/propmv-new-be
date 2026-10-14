'use strict';

const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const {
  PayloadDepositMethod,
  DEPOSIT_ROUTE_TYPE,
  DEPOSIT_METHOD_STATUS,
  DEPOSIT_METHOD_TYPE,
} = require('../model/payloadDepositMethod.model');
const { PayloadClient } = require('../client/payload.client');
const {
  AUDIT_EVENTS,
  DEPOSIT_ROUTE_KEYS,
} = require('../constants/payload.constants');
const {
  findAccountById,
  assertPayloadMerchantAccess,
  assertVendorMerchantFeatureEnabled,
  ensurePayloadEnabled,
  sanitizeMerchantRecord,
  syncPayloadAccountFromRemote,
} = require('./payloadMerchant.service');
const {
  createDepositMethodSession,
  createMerchantOnboardingSession,
} = require('./payloadComponentSession.service');
const {
  resolveDepositBankSetupFlow,
  depositBankBlockedReason,
  mapPayloadProcessingStatus,
} = require('../utils/payloadStatus.util');
const { auditPayload } = require('./payloadAudit.helper');
const { ENTITY_TYPE } = require('../constants/payload.constants');
const payloadConfig = require('../../../../../../config/payload.config');
const logger = require('../../../../../../common/logger');

const client = new PayloadClient();

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
  const ach = remote?.ach || remote?.plaid_ach || remote?.bank_account || {};
  const billing = remote?.billing_contact || remote?.billing_address || {};
  const accountNumber = ach?.account_number || ach?.account_number_last_4 || '';
  const digits = accountNumber ? String(accountNumber).replace(/\D/g, '') : '';
  const last4 =
    ach?.account_number_last_4
    || ach?.last4
    || (digits.length >= 4 ? digits.slice(-4) : '');
  return {
    holderName: remote?.account_holder || billing?.name || '',
    last4,
    routingNumber: ach?.routing_number || '',
    bankName: remote?.bank_name || ach?.bank_name || '',
    accountType: normalizeAccountType(ach?.account_type || ach?.accountType),
  };
}

/** Canonical Payload payment method id (`pm_…`). Prefer `id` over legacy `deposit_method_id` aliases. */
function resolvePayloadPaymentMethodId(remote = {}) {
  if (typeof remote === 'string') return String(remote).trim();
  return String(
    remote?.id
    || remote?.payment_method_id
    || remote?.paymentMethodId
    || remote?.deposit_method_id
    || remote?.depositMethodId
    || ''
  ).trim();
}

function collectPaymentMethodAliasIds(remote = {}) {
  if (typeof remote === 'string') return [String(remote).trim()].filter(Boolean);
  const aliases = new Set();
  [
    remote?.id,
    remote?.payment_method_id,
    remote?.paymentMethodId,
    remote?.deposit_method_id,
    remote?.depositMethodId,
  ].forEach((value) => {
    const id = String(value || '').trim();
    if (id) aliases.add(id);
  });
  return [...aliases];
}

function isPayloadBankPaymentMethod(remote = {}) {
  const type = String(remote?.type || remote?.method_type || remote?.methodType || '').toLowerCase();
  if (type === 'bank_account') return true;
  if (remote?.bank_account && typeof remote.bank_account === 'object') return true;
  return false;
}

function normalizeRemotePaymentMethodStatus(status) {
  const raw = String(status || DEPOSIT_METHOD_STATUS.CREATED).toLowerCase();
  if (raw === 'active') return DEPOSIT_METHOD_STATUS.ACTIVE;
  if (raw === 'inactive' || raw === 'declining') return String(raw).toUpperCase();
  return String(status || DEPOSIT_METHOD_STATUS.CREATED).toUpperCase();
}

function unwrapPayloadList(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.values)) return body.values;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

function resolveRouteFlags(depositMethodId, depositRoutes = {}, remote = {}) {
  if (remote?.default_deposit_method) {
    return {
      routeType: DEPOSIT_ROUTE_TYPE.PAYMENTS,
      isPrimaryPayout: true,
      assignedRoutes: [DEPOSIT_ROUTE_KEYS.PAYMENTS],
    };
  }

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

function extractVerificationStatus(remote = {}) {
  return String(
    remote?.verification_status
    || remote?.verificationStatus
    || remote?.bank_account?.verification_status
    || ''
  ).trim().toLowerCase();
}

function extractTransferType(remote = {}) {
  return String(
    remote?.transfer_type
    || remote?.transferType
    || remote?.bank_account?.transfer_type
    || ''
  ).trim().toLowerCase();
}

function extractDefaultDepositMethod(remote = {}) {
  if (typeof remote?.default_deposit_method === 'boolean') return remote.default_deposit_method;
  if (typeof remote?.defaultDepositMethod === 'boolean') return remote.defaultDepositMethod;
  return null;
}

/**
 * Resolve Payload processing account id ownership of a payment method.
 * Vendor/HOA deposit banks must belong to the merchant's processing account.
 */
function resolveRemotePaymentMethodAccountId(remote = {}) {
  return String(
    remote?.account_id
    || remote?.accountId
    || remote?.processing_id
    || remote?.processingId
    || remote?.customer_id
    || remote?.customerId
    || ''
  ).trim();
}

function sanitizeDepositMethodRecord(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const defaultDeposit = typeof row.defaultDepositMethod === 'boolean'
    ? row.defaultDepositMethod
    : !!row.isPrimaryPayout;
  return {
    id: String(row._id),
    payloadAccountId: String(row.payloadAccountRef),
    merchantId: row.merchantId || '',
    depositMethodId: row.depositMethodId || '',
    depositMethodConfigId: row.depositMethodConfigId || '',
    routeType: row.routeType || DEPOSIT_ROUTE_TYPE.AVAILABLE,
    /** Compatibility mirror of Payload default_deposit_method (not a payout destination). */
    isPrimary: !!row.isPrimaryPayout,
    isPrimaryPayout: !!row.isPrimaryPayout,
    defaultDepositMethod: defaultDeposit,
    status: row.status || '',
    verificationStatus: row.verificationStatus || '',
    transferType: row.transferType || '',
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
  ensurePayloadEnabled();
  const account = await findAccountById(accountId);
  if (!account) {
    const err = new Error('Payload business account not found.');
    err.statusCode = 404;
    throw err;
  }
  // Phase 2: every Vendor deposit-method operation requires the Vendor merchant flag.
  if (String(account.entityType || '').toLowerCase() === ENTITY_TYPE.VENDOR) {
    assertVendorMerchantFeatureEnabled();
  }
  assertPayloadMerchantAccess(account, { businessId, userId });
  if (!account.merchantId) {
    const err = new Error('Payload merchant is not initialized for this business account.');
    err.statusCode = 400;
    throw err;
  }
  return account;
}

/**
 * Reject attaching a pm_… that already belongs to a different PropMV PayloadAccount.
 * Account-scoped duplicates are handled by findExistingDepositMethodDoc (update-in-place).
 */
async function assertDepositMethodNotOwnedByOtherAccount({ account, depositMethodId, aliasIds = [] }) {
  const ids = [...new Set(
    [depositMethodId, ...(aliasIds || [])].map((id) => String(id || '').trim()).filter(Boolean)
  )];
  if (!ids.length) return;

  const foreign = await PayloadDepositMethod.findOne({
    depositMethodId: { $in: ids },
    payloadAccountRef: { $ne: account._id },
    isDeleted: { $ne: true },
  }).lean();

  if (foreign) {
    const err = new Error(
      'This Payload bank payment method is already linked to another business account and cannot be reused.'
    );
    err.statusCode = 409;
    err.code = 'DEPOSIT_METHOD_CROSS_ACCOUNT';
    throw err;
  }
}

/**
 * Ensure the remote Payload PM is attached to this Vendor/HOA Processing Account.
 */
function assertRemotePaymentMethodBelongsToAccount({ account, remote }) {
  const remoteAccountId = resolveRemotePaymentMethodAccountId(remote);
  if (!remoteAccountId) return; // some Payload list embeds omit account_id; sync path still account-scoped
  if (String(remoteAccountId) !== String(account.merchantId)) {
    const err = new Error(
      'This Payload bank payment method does not belong to this Processing Account.'
    );
    err.statusCode = 403;
    err.code = 'DEPOSIT_METHOD_WRONG_ACCOUNT';
    throw err;
  }
}

/**
 * Account-scoped duplicate detection only. Never returns another account's row.
 */
async function findExistingDepositMethodDoc({ account, depositMethodId, display, remote }) {
  const canonicalId = String(depositMethodId || '').trim();
  const aliasIds = collectPaymentMethodAliasIds(remote);

  if (aliasIds.length) {
    const doc = await PayloadDepositMethod.findOne({
      payloadAccountRef: account._id,
      depositMethodId: { $in: aliasIds },
      isDeleted: { $ne: true },
    });
    if (doc) return doc;
  }

  if (canonicalId) {
    const doc = await PayloadDepositMethod.findOne({
      payloadAccountRef: account._id,
      depositMethodId: canonicalId,
      isDeleted: { $ne: true },
    });
    if (doc) return doc;
  }

  const fingerprint = String(remote?.fingerprint || '').trim();
  if (fingerprint) {
    const doc = await PayloadDepositMethod.findOne({
      payloadAccountRef: account._id,
      fingerprint,
      isDeleted: { $ne: true },
    });
    if (doc) return doc;
  }

  if (display?.last4) {
    const matchQuery = {
      payloadAccountRef: account._id,
      isDeleted: { $ne: true },
      last4: display.last4,
      accountType: display.accountType || 'unknown',
    };
    if (display.routingNumber) {
      matchQuery.routingNumber = display.routingNumber;
    }
    const doc = await PayloadDepositMethod.findOne(matchQuery);
    if (doc) return doc;
  }

  return null;
}

async function mergeDuplicateDepositMethodsForAccount(accountRef) {
  const rows = await PayloadDepositMethod.find({
    payloadAccountRef: accountRef,
    isDeleted: { $ne: true },
  }).sort({ isPrimaryPayout: -1, createdAt: -1 });

  const groups = new Map();
  rows.forEach((row) => {
    if (!row.last4) return;
    const key = [
      row.merchantId || '',
      row.last4,
      row.routingNumber || '',
      row.accountType || 'unknown',
      String(row.holderName || '').trim().toLowerCase(),
    ].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  for (const dupes of groups.values()) {
    if (dupes.length <= 1) continue;
    const [keep, ...rest] = dupes;
    for (const dupe of rest) {
      dupe.isDeleted = true;
      dupe.deletedAt = ClockService.now();
      await dupe.save();
      auditPayload({
        event: AUDIT_EVENTS.DEPOSIT_METHOD_SYNCED,
        entity: 'PayloadDepositMethod',
        entityId: dupe._id,
        after: { action: 'merge_duplicate_deposit_method', keptId: String(keep._id) },
      });
    }
    if (!keep.depositMethodId.startsWith('pm_') && dupes.some((d) => String(d.depositMethodId).startsWith('pm_'))) {
      const canonical = dupes.find((d) => String(d.depositMethodId).startsWith('pm_'));
      if (canonical?.depositMethodId) {
        keep.depositMethodId = canonical.depositMethodId;
        await keep.save();
      }
    }
  }
}

async function upsertDepositMethodFromRemote({
  account,
  remote,
  depositRoutes,
  webhookAt = null,
  createdBy = null,
  /** When true (register path), require remote PM account_id to match merchantId when present. */
  enforceRemoteAccountOwnership = false,
}) {
  const depositMethodId = resolvePayloadPaymentMethodId(remote);
  if (!depositMethodId) return null;

  if (enforceRemoteAccountOwnership) {
    assertRemotePaymentMethodBelongsToAccount({ account, remote });
  }

  const aliasIds = collectPaymentMethodAliasIds(remote);
  await assertDepositMethodNotOwnedByOtherAccount({
    account,
    depositMethodId,
    aliasIds,
  });

  const display = extractAchDisplay(remote);
  const { routeType, isPrimaryPayout } = resolveRouteFlags(depositMethodId, depositRoutes, remote);
  const methodTypeRaw = String(
    remote?.method_type || remote?.methodType || remote?.type || DEPOSIT_METHOD_TYPE.ACH
  ).toUpperCase();
  const methodType = methodTypeRaw === 'BANK_ACCOUNT' ? DEPOSIT_METHOD_TYPE.ACH : methodTypeRaw;
  const verificationStatus = extractVerificationStatus(remote);
  const transferType = extractTransferType(remote);
  const remoteDefault = extractDefaultDepositMethod(remote);
  // Payload default_deposit_method is source of truth; isPrimaryPayout is local mirror only.
  const defaultDepositMethod = remoteDefault === null ? !!isPrimaryPayout : remoteDefault;
  const primaryMirror = defaultDepositMethod;

  let doc = await findExistingDepositMethodDoc({ account, depositMethodId, display, remote });

  const before = doc ? sanitizeDepositMethodRecord(doc) : null;
  const payload = {
    provider: account.provider,
    payloadAccountRef: account._id,
    businessId: account.businessId,
    entityType: account.entityType,
    entityId: account.entityId,
    merchantId: account.merchantId,
    depositMethodId: String(depositMethodId),
    depositMethodConfigId: remote?.deposit_method_config_id || remote?.depositMethodConfigId || '',
    routeType: primaryMirror ? DEPOSIT_ROUTE_TYPE.PAYMENTS : routeType,
    isPrimaryPayout: primaryMirror,
    defaultDepositMethod: primaryMirror,
    status: normalizeRemotePaymentMethodStatus(remote?.status),
    verificationStatus,
    transferType,
    methodType: Object.values(DEPOSIT_METHOD_TYPE).includes(methodType) ? methodType : DEPOSIT_METHOD_TYPE.ACH,
    holderName: display.holderName,
    routingNumber: display.routingNumber,
    last4: display.last4,
    bankName: display.bankName,
    accountType: display.accountType,
    fingerprint: remote?.fingerprint || '',
    metadata: {
      ...(doc?.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}),
      payloadVerificationStatus: verificationStatus || undefined,
      payloadTransferType: transferType || undefined,
      payloadDefaultDepositMethod: primaryMirror,
    },
    latestResponse: remote,
    lastSyncedAt: ClockService.now(),
    ...(webhookAt ? { lastWebhookAt: webhookAt } : {}),
    updatedBy: createdBy ? toObjectId(createdBy) : undefined,
  };

  if (!doc) {
    doc = await PayloadDepositMethod.create({
      ...payload,
      createdBy: createdBy ? toObjectId(createdBy) : null,
    });
    auditPayload({
      event: AUDIT_EVENTS.DEPOSIT_METHOD_ADDED,
      entity: 'PayloadDepositMethod',
      entityId: doc._id,
      createdBy,
      after: sanitizeDepositMethodRecord(doc),
    });
    return doc;
  }

  Object.assign(doc, payload);
  await doc.save();

  auditPayload({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_SYNCED,
    entity: 'PayloadDepositMethod',
    entityId: doc._id,
    before,
    after: sanitizeDepositMethodRecord(doc),
  });

  return doc;
}

/**
 * Reconcile local primary/default mirrors from Payload deposit_routes.PAYMENTS.
 *
 * IMPORTANT: When PAYMENTS route id is absent (common for Vendor / sandbox pending
 * merchants), do NOT clear local flags. Clearing wiped Vendor defaults that were
 * correctly set from PM.default_deposit_method and caused
 * "Vendor default deposit bank is not configured." on payin validate.
 *
 * @param {import('mongoose').Types.ObjectId|string} accountRef
 * @param {object} depositRoutes
 * @param {{ preferredDepositMethodId?: string }} [options]
 */
async function reconcilePrimaryFlags(accountRef, depositRoutes = {}, options = {}) {
  const paymentsRouteId =
    depositRoutes?.PAYMENTS?.deposit_method_id
    || depositRoutes?.PAYMENTS?.depositMethodId
    || options.preferredDepositMethodId
    || '';

  if (!paymentsRouteId) {
    // Preserve mirrors set by upsertDepositMethodFromRemote / PM.default_deposit_method.
    return;
  }

  // isPrimaryPayout + defaultDepositMethod are local mirrors of Payload default_deposit_method.
  await PayloadDepositMethod.updateMany(
    { payloadAccountRef: accountRef, isDeleted: { $ne: true } },
    { $set: { isPrimaryPayout: false, defaultDepositMethod: false } }
  );

  await PayloadDepositMethod.updateMany(
    {
      payloadAccountRef: accountRef,
      depositMethodId: String(paymentsRouteId),
      isDeleted: { $ne: true },
    },
    {
      $set: {
        isPrimaryPayout: true,
        defaultDepositMethod: true,
        routeType: DEPOSIT_ROUTE_TYPE.PAYMENTS,
      },
    }
  );
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

function collectBankPaymentMethodsFromProcessingAccount(remoteMerchant = {}, remoteApplication = null) {
  const paymentMethods = [
    ...(remoteMerchant?.payment_methods || []),
    ...(remoteApplication?.payment_methods || []),
  ];
  const banks = [];
  const seen = new Set();

  paymentMethods.forEach((pm) => {
    if (!pm) return;
    if (typeof pm === 'string') {
      const id = String(pm).trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      banks.push({ id, type: 'bank_account' });
      return;
    }
    if (!isPayloadBankPaymentMethod(pm)) return;
    const id = resolvePayloadPaymentMethodId(pm);
    if (!id) return;
    const aliases = collectPaymentMethodAliasIds(pm);
    if (aliases.some((alias) => seen.has(alias))) return;
    aliases.forEach((alias) => seen.add(alias));
    banks.push(pm);
  });

  return banks;
}

function collectDepositMethodIds(remoteMerchant = {}, remoteApplication = null) {
  const banks = collectBankPaymentMethodsFromProcessingAccount(remoteMerchant, remoteApplication);
  if (banks.length) {
    return banks.map((pm) => resolvePayloadPaymentMethodId(pm)).filter(Boolean);
  }
  const ids = new Set(collectDepositMethodIdsFromSource(remoteMerchant));
  if (remoteApplication) {
    collectDepositMethodIdsFromSource(remoteApplication).forEach((id) => ids.add(id));
  }
  return [...ids];
}

async function fetchProcessingAccountBankMethods(processingAccountId) {
  if (!processingAccountId) return [];
  try {
    const listed = await client.listProcessingAccountPaymentMethods(processingAccountId);
    return unwrapPayloadList(listed).filter((pm) => isPayloadBankPaymentMethod(pm));
  } catch (err) {
    logger.warn('[PayloadDepositMethod] list payment_methods failed', {
      processingAccountId,
      message: err.message,
    });
    return [];
  }
}

function mergeDepositRoutes(primary = {}, fallback = {}) {
  return { ...(fallback || {}), ...(primary || {}) };
}

async function resolveDepositSyncContext(account, remoteMerchant) {
  let depositRoutes = { ...(remoteMerchant?.deposit_routes || {}) };
  let bankMethods = collectBankPaymentMethodsFromProcessingAccount(remoteMerchant);

  if (!bankMethods.length) {
    bankMethods = await fetchProcessingAccountBankMethods(account.merchantId);
  }

  const ids = bankMethods.length
    ? bankMethods.map((pm) => resolvePayloadPaymentMethodId(pm)).filter(Boolean)
    : collectDepositMethodIds(remoteMerchant);

  return { depositRoutes, ids, bankMethods };
}

async function syncSingleBankPaymentMethod({
  account,
  depositMethodId,
  bankMethodsById,
  depositRoutes,
  createdBy,
}) {
  const embedded = bankMethodsById?.get(String(depositMethodId));
  let remoteMethod = embedded && typeof embedded === 'object' ? embedded : null;

  if (!remoteMethod?.type) {
    remoteMethod = await client.getDepositMethod(depositMethodId);
  }

  if (!isPayloadBankPaymentMethod(remoteMethod)) return null;

  return upsertDepositMethodFromRemote({
    account,
    remote: remoteMethod,
    depositRoutes,
    createdBy,
  });
}

async function syncDepositMethodsForAccount({
  accountId,
  businessId,
  userId,
  req = null,
}) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });

  let remote = null;
  try {
    remote = await client.getProcessingAccount(account.merchantId);
  } catch (err) {
    logger.warn('[PayloadDepositMethod] Processing account fetch failed during sync', {
      merchantId: account.merchantId,
      message: err.message,
    });
    const errOut = new Error(
      err.message || 'Unable to load the Payload processing account. Confirm the account is linked and your API key matches the Payload test profile.'
    );
    errOut.statusCode = err.statusCode || 502;
    throw errOut;
  }

  account.merchantStatus = String(remote?.status || account.merchantStatus).toUpperCase();
  account.applicationStatus = account.merchantStatus;
  account.onboardingStatus = mapPayloadProcessingStatus(remote?.status);
  account.lastSyncedAt = ClockService.now();
  await account.save();

  const { depositRoutes, ids, bankMethods } = await resolveDepositSyncContext(account, remote);
  const bankMethodsById = new Map(
    (bankMethods || []).map((pm) => [resolvePayloadPaymentMethodId(pm), pm]).filter(([id]) => id)
  );
  const synced = [];

  for (const depositMethodId of ids) {
    try {
      const doc = await syncSingleBankPaymentMethod({
        account,
        depositMethodId,
        bankMethodsById,
        depositRoutes,
        createdBy: userId,
      });
      if (doc) synced.push(sanitizeDepositMethodRecord(doc));
    } catch (err) {
      logger.warn('[PayloadDepositMethod] Sync fetch failed', {
        depositMethodId,
        message: err.message,
      });
    }
  }

  await reconcilePrimaryFlags(account._id, depositRoutes);
  await mergeDuplicateDepositMethodsForAccount(account._id);

  auditPayload({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_SYNCED,
    entity: 'PayloadAccount',
    entityId: account._id,
    createdBy: userId,
    after: { accountId: String(account._id), count: synced.length },
    req,
  });

  return synced;
}

async function listDepositMethodsForAccount({ accountId, businessId, userId }) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  let rows = await PayloadDepositMethod.find({
    payloadAccountRef: account._id,
    isDeleted: { $ne: true },
  }).sort({ isPrimaryPayout: -1, createdAt: -1 });

  if (!rows.length) {
    try {
      await syncDepositMethodsForAccount({ accountId, businessId, userId });
    } catch (err) {
      logger.warn('[PayloadDepositMethod] Auto-sync during list failed', {
        accountId,
        message: err.message,
      });
      if (err.statusCode === 400 || err.statusCode === 404) {
        const errOut = new Error(
          err.message
          || 'Unable to sync deposit banks from Payload. Confirm the processing account exists in your Payload test profile.'
        );
        errOut.statusCode = 502;
        throw errOut;
      }
      throw err;
    }
    rows = await PayloadDepositMethod.find({
      payloadAccountRef: account._id,
      isDeleted: { $ne: true },
    }).sort({ isPrimaryPayout: -1, createdAt: -1 });
  }

  if (rows.length > 1) {
    await mergeDuplicateDepositMethodsForAccount(account._id);
    rows = await PayloadDepositMethod.find({
      payloadAccountRef: account._id,
      isDeleted: { $ne: true },
    }).sort({ isPrimaryPayout: -1, createdAt: -1 });
  }

  return rows.map(sanitizeDepositMethodRecord);
}

async function getMerchantDetail({ accountId, businessId, userId }) {
  const account = await loadAccountWithAccess({ accountId, businessId, userId });
  await syncPayloadAccountFromRemote(account);
  const refreshedAccount = await findAccountById(accountId);

  let remoteSummary = null;

  try {
    const remote = await client.getProcessingAccount(refreshedAccount.merchantId);
    remoteSummary = {
      depositRoutes: remote?.deposit_routes || {},
      availableDepositMethodIds: remote?.available_deposit_method_ids || [],
      billingType: remote?.billing_type || '',
      depositFrequency: remote?.deposit_frequency || '',
    };
  } catch (err) {
    logger.warn('[PayloadDepositMethod] Merchant detail sync failed', {
      merchantId: refreshedAccount.merchantId,
      message: err.message,
    });
  }

  await syncDepositMethodsForAccount({ accountId, businessId, userId });
  const depositMethods = await PayloadDepositMethod.find({
    payloadAccountRef: refreshedAccount._id,
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
  await syncPayloadAccountFromRemote(account);
  const refreshed = await findAccountById(accountId);

  if (!refreshed?.merchantId) {
    const err = new Error('Payload merchant is not initialized for this business account.');
    err.statusCode = 400;
    throw err;
  }

  let merchantApplicationId = refreshed.merchantApplicationId || '';
  if (!merchantApplicationId) {
    try {
      const remote = await client.getProcessingAccount(refreshed.merchantId);
      merchantApplicationId =
        remote?.latest_merchant_application?.merchant_application_id || merchantApplicationId;
    } catch (err) {
      logger.warn('[PayloadDepositMethod] Merchant lookup failed during initialize', {
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
    termsAndConditionsUrl: payloadConfig.payload.termsAndConditionsUrl || '',
  };

  if (flow === 'blocked') {
    auditPayload({
      event: AUDIT_EVENTS.DEPOSIT_METHOD_SYNCED,
      entity: 'PayloadAccount',
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
      'Payload merchant application is not available yet. Complete merchant onboarding before adding deposit banks.'
    );
    err.statusCode = 400;
    throw err;
  }

  if (merchantApplicationId && merchantApplicationId !== refreshed.merchantApplicationId) {
    refreshed.merchantApplicationId = merchantApplicationId;
    await refreshed.save();
  }

  const session = flow === 'hub'
    ? await createDepositMethodSession({ merchantId: refreshed.merchantId })
    : await createMerchantOnboardingSession({ merchantId: refreshed.merchantId });

  auditPayload({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_ADDED,
    entity: 'PayloadAccount',
    entityId: refreshed._id,
    createdBy: userId,
    after: {
      merchantApplicationId: basePayload.merchantApplicationId,
      flow,
      action: flow === 'hub' ? 'initialize_deposit_method_session' : 'initialize_onboarding_session',
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
  if (!isPayloadBankPaymentMethod(remoteMethod)) {
    const err = new Error('Only bank payment methods can be registered as deposit banks.');
    err.statusCode = 400;
    throw err;
  }

  assertRemotePaymentMethodBelongsToAccount({ account, remote: remoteMethod });
  await assertDepositMethodNotOwnedByOtherAccount({
    account,
    depositMethodId,
    aliasIds: collectPaymentMethodAliasIds(remoteMethod),
  });

  // Account-scoped duplicate: same pm_ already on this Vendor/HOA account → sync in place (safe).
  // Cross-account reuse already rejected above.

  const remoteMerchant = await client.getProcessingAccount(account.merchantId);
  const depositRoutes = { ...(remoteMerchant?.deposit_routes || {}) };

  if (setAsPrimary) {
    try {
      // Payload default_deposit_method is source of truth for Primary deposit bank.
      await client.updatePaymentMethod(depositMethodId, { default_deposit_method: true });
    } catch (patchErr) {
      logger.warn('[PayloadDepositMethod] Primary deposit flag update failed', {
        depositMethodId,
        message: patchErr.message,
      });
      throw patchErr;
    }
  }

  const refreshedMerchant = await client.getProcessingAccount(account.merchantId);
  const remoteDefault = extractDefaultDepositMethod(remoteMethod) === true || setAsPrimary;
  const doc = await upsertDepositMethodFromRemote({
    account,
    remote: {
      ...remoteMethod,
      deposit_method_config_id: depositMethodConfigId || remoteMethod?.deposit_method_config_id,
      ...(remoteDefault ? { default_deposit_method: true } : {}),
    },
    depositRoutes: refreshedMerchant?.deposit_routes || depositRoutes,
    createdBy: userId,
    enforceRemoteAccountOwnership: true,
  });

  // Same lag guard as setPrimaryDepositMethod: deposit_routes may omit PAYMENTS
  // while PM.default_deposit_method is already true (Vendor sandbox).
  const routesForReconcile = {
    ...(refreshedMerchant?.deposit_routes || depositRoutes || {}),
  };
  if (remoteDefault) {
    routesForReconcile[DEPOSIT_ROUTE_KEYS.PAYMENTS] = {
      ...(routesForReconcile[DEPOSIT_ROUTE_KEYS.PAYMENTS] || {}),
      deposit_method_id: String(depositMethodId),
    };
  }
  await reconcilePrimaryFlags(account._id, routesForReconcile, {
    preferredDepositMethodId: remoteDefault ? String(depositMethodId) : undefined,
  });
  await mergeDuplicateDepositMethodsForAccount(account._id);

  auditPayload({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_ADDED,
    entity: 'PayloadDepositMethod',
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
  const bank = await PayloadDepositMethod.findOne({
    _id: toObjectId(depositMethodLocalId),
    payloadAccountRef: account._id,
    isDeleted: { $ne: true },
  });

  if (!bank?.depositMethodId) {
    const err = new Error('Deposit bank account not found.');
    err.statusCode = 404;
    throw err;
  }

  const remoteMerchant = await client.getProcessingAccount(account.merchantId);
  // Payload default_deposit_method is source of truth; isPrimaryPayout is local mirror only.
  await client.updatePaymentMethod(bank.depositMethodId, { default_deposit_method: true });

  // Prefer the bank we just marked primary. Remote deposit_routes may lag behind
  // default_deposit_method and would otherwise wipe isPrimaryPayout in reconcile.
  const depositRoutes = {
    ...(remoteMerchant?.deposit_routes || {}),
    [DEPOSIT_ROUTE_KEYS.PAYMENTS]: {
      ...((remoteMerchant?.deposit_routes || {})[DEPOSIT_ROUTE_KEYS.PAYMENTS] || {}),
      deposit_method_id: bank.depositMethodId,
    },
  };

  let refreshedMerchant = remoteMerchant;
  try {
    refreshedMerchant = await client.getProcessingAccount(account.merchantId);
  } catch (err) {
    logger.warn('[PayloadDepositMethod] Primary refresh failed; using local route map', {
      message: err.message,
    });
  }

  const before = sanitizeDepositMethodRecord(bank);

  bank.isPrimaryPayout = true;
  bank.defaultDepositMethod = true;
  bank.routeType = DEPOSIT_ROUTE_TYPE.PAYMENTS;
  bank.lastSyncedAt = ClockService.now();
  await bank.save();

  const routesForReconcile = {
    ...(refreshedMerchant?.deposit_routes || {}),
    ...depositRoutes,
    [DEPOSIT_ROUTE_KEYS.PAYMENTS]: {
      ...((refreshedMerchant?.deposit_routes || {})[DEPOSIT_ROUTE_KEYS.PAYMENTS] || {}),
      ...depositRoutes[DEPOSIT_ROUTE_KEYS.PAYMENTS],
      deposit_method_id: bank.depositMethodId,
    },
  };
  await reconcilePrimaryFlags(account._id, routesForReconcile);

  auditPayload({
    event: AUDIT_EVENTS.DEPOSIT_METHOD_PRIMARY_UPDATED,
    entity: 'PayloadDepositMethod',
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

  const bank = await PayloadDepositMethod.findOne({
    depositMethodId: String(depositMethodId),
    isDeleted: { $ne: true },
  });
  if (!bank) return null;

  const PayloadAccount = require('../model/payloadAccount.model');
  const account = await PayloadAccount.findById(bank.payloadAccountRef);
  if (!account) return bank;

  let depositRoutes = {};
  try {
    const remoteMerchant = await client.getProcessingAccount(account.merchantId);
    depositRoutes = remoteMerchant?.deposit_routes || {};
  } catch (err) {
    logger.warn('[PayloadDepositMethod] Webhook merchant fetch failed', { message: err.message });
  }

  return upsertDepositMethodFromRemote({
    account,
    remote: remotePayload || { deposit_method_id: depositMethodId },
    depositRoutes,
    webhookAt,
  });
}

async function syncDepositMethodsFromMerchantWebhook({ merchantId, remoteMerchant, webhookAt = null }) {
  const PayloadAccount = require('../model/payloadAccount.model');
  const account = await PayloadAccount.findOne({ merchantId: String(merchantId), isDeleted: { $ne: true } });
  if (!account) return [];

  let remote = remoteMerchant;
  if (!remote?.payment_methods?.length && !remote?.deposit_routes) {
    try {
      remote = await client.getProcessingAccount(account.merchantId);
    } catch (err) {
      logger.warn('[PayloadDepositMethod] Webhook merchant fetch failed', { message: err.message });
      remote = remoteMerchant || {};
    }
  }

  const { depositRoutes, ids, bankMethods } = await resolveDepositSyncContext(account, remote);
  const synced = [];

  const bankMethodsById = new Map(
    (bankMethods || []).map((pm) => [resolvePayloadPaymentMethodId(pm), pm]).filter(([id]) => id)
  );

  for (const depositMethodId of ids) {
    try {
      const doc = await syncSingleBankPaymentMethod({
        account,
        depositMethodId,
        bankMethodsById,
        depositRoutes,
        createdBy: null,
      });
      if (doc) {
        if (webhookAt) {
          doc.lastWebhookAt = webhookAt;
          await doc.save();
        }
        synced.push(doc);
      }
    } catch (err) {
      logger.warn('[PayloadDepositMethod] Webhook sync fetch failed', {
        depositMethodId,
        message: err.message,
      });
    }
  }

  await reconcilePrimaryFlags(account._id, depositRoutes);
  await mergeDuplicateDepositMethodsForAccount(account._id);
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
  findExistingDepositMethodDoc,
  assertDepositMethodNotOwnedByOtherAccount,
  assertRemotePaymentMethodBelongsToAccount,
  extractVerificationStatus,
  extractTransferType,
  extractDefaultDepositMethod,
  reconcilePrimaryFlags,
  loadAccountWithAccess,
};
