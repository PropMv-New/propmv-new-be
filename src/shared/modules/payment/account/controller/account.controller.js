'use strict';

const { AccountService } = require('../service/account.service');
const { AccountWebhookService } = require('../service/accountWebhook.service');
const { LinkedBankService } = require('../service/linkedBank.service');
const { RepresentativeService } = require('../service/representative.service');
const LinkedBankAccount = require('../model/linkedBankAccount.model');
const {
  assertAccountAccess,
  resolveHoaBoardEntityId,
  isHoaBoardAccount,
} = require('../service/accountAccess.helper');
const { ENTITY_TYPE } = require('../constants/account.constants');
const { success, error } = require('../../../../../common/helpers/responseHelper');
const logger = require('../../../../../common/logger');
const mongoose = require('mongoose');
const straddleConfig = require('../../../../../config/straddle.config');

const accountService = new AccountService();
const webhookService = new AccountWebhookService();
const linkedBankService = new LinkedBankService();
const representativeService = new RepresentativeService();

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || null;
}

async function enrichAccountsWithBankSummary(records) {
  if (!records?.length) return records;
  const ids = records.map((r) => r._id);
  const banks = await LinkedBankAccount.find({
    straddleAccountRef: { $in: ids },
    isDeleted: { $ne: true },
  }).lean();
  const byAccount = {};
  for (const b of banks) {
    const key = String(b.straddleAccountRef);
    if (!byAccount[key]) byAccount[key] = [];
    byAccount[key].push(b);
  }
  return records.map((r) => {
    const list = byAccount[String(r._id)] || [];
    const primary = list.find((b) => b.isPrimary) || list[0] || null;
    return {
      ...r,
      linkedBankCount: list.length,
      primaryBank: primary
        ? {
            _id: primary._id,
            last4: primary.last4,
            holderName: primary.holderName,
            status: primary.status,
            verificationStatus: primary.verificationStatus,
            isPrimary: !!primary.isPrimary,
          }
        : null,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ctx(req) {
  return {
    createdBy:     req.user?._id || null,
    correlationId: req.headers['x-correlation-id'] || null,
    requestId:     req.headers['x-request-id'] || null,
    req,
  };
}

/**
 * companyId is role/company scoping (Property Manager / Landlord company).
 * Never trust client-supplied businessId - derive from authenticated user.
 * HOA board: entityId is the board member user id; client entityId is stored as metadata.hoaId.
 */
function resolveOwnership(req) {
  const userId = req.user?._id || req.user?.id || null;
  const companyId = req.user?.companyId || null;
  const businessId = companyId || userId;
  const bodyEntityType = req.body?.entityType;
  const clientEntityId = req.body?.entityId || null;

  if (isHoaBoardAccount(bodyEntityType) && userId) {
    const { entityId, metadataHoaId } = resolveHoaBoardEntityId(userId, clientEntityId);
    return { businessId, entityId, companyId, userId, metadataHoaId };
  }

  const entityId = clientEntityId || new mongoose.Types.ObjectId().toString();
  return { businessId, entityId, companyId, userId, metadataHoaId: null };
}

function ownershipFromRequest(req) {
  const userId = req.user?._id || req.user?.id || null;
  const companyId = req.user?.companyId || null;
  return { businessId: companyId || null, userId };
}

async function loadAccountForUser(req, recordId) {
  const record = await accountService.getAccountById(recordId);
  if (!record) {
    const err = new Error('Account not found');
    err.statusCode = 404;
    throw err;
  }
  assertAccountAccess(record, ownershipFromRequest(req));
  return record;
}

function bankOwnership(req) {
  const userId = req.user?._id || req.user?.id || null;
  const companyId = req.user?.companyId || null;
  return {
    businessId: companyId || null,
    userId,
    correlationId: req.headers['x-correlation-id'] || null,
    requestId: req.headers['x-request-id'] || null,
    req,
  };
}

/** Shape LinkedBank for existing frontend AccountBankRecord consumers */
function toBankDto(bank) {
  if (!bank) return bank;
  const b = typeof bank.toObject === 'function' ? bank.toObject() : bank;
  return {
    ...b,
    // Compatibility aliases used by shared UI
    straddleAccountId: b.straddleAccountRef || b.straddleAccountId,
    paykeyId: b.linkedBankAccountId || null,
    straddle: {
      success: !!b.linkedBankAccountId,
      gatewayId: b.linkedBankAccountId || undefined,
      status: b.status,
      raw: b.latestResponse || undefined,
    },
  };
}

// ── Account CRUD ──────────────────────────────────────────────────────────────

const createAccount = async (req, res, next) => {
  try {
    const { businessId, entityId, metadataHoaId } = resolveOwnership(req);
    if (!businessId) {
      return error(res, 'Unable to resolve company association for this user.', 400);
    }
    const record = await accountService.createAccount({
      ...req.body,
      businessId: String(businessId),
      entityId: String(entityId),
      metadata: {
        ...(req.body.metadata || {}),
        ...(metadataHoaId ? { hoaId: metadataHoaId } : {}),
      },
      ...ctx(req),
    });
    logger.info('[AccountController] createAccount', { recordId: record._id, businessId, entityId, metadataHoaId });
    return success(res, record, 'Account created', 201);
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to create account', err.statusCode);
    }
    next(err);
  }
};

const listAccounts = async (req, res, next) => {
  try {
    const { entityType } = req.query;
    const userId = req.user?._id || req.user?.id || null;
    const companyId = req.user?.companyId || null;
    const hoaId = req.headers['x-hoa-id'] || req.hoaContext?.hoaId || null;

    const records = await accountService.listAccounts(
      entityType === ENTITY_TYPE.HOA
        ? hoaId
          ? {
              entityType: ENTITY_TYPE.HOA,
              hoaId,
            }
          : {
              entityType: ENTITY_TYPE.HOA,
              createdBy: userId,
            }
        : {
            businessId: companyId || undefined,
            createdBy: companyId ? undefined : userId,
            entityType: entityType || undefined,
          }
    );
    const enriched = await enrichAccountsWithBankSummary(records);
    return success(res, enriched);
  } catch (err) {
    next(err);
  }
};

const getAccountByEntity = async (req, res, next) => {
  try {
    const { entityId, entityType } = req.params;
    const userId = req.user?._id || req.user?.id || null;
    let record;

    if (entityType === ENTITY_TYPE.HOA && userId) {
      record = await accountService.getAccountByEntity(userId, ENTITY_TYPE.HOA, { createdBy: userId });
    } else {
      record = await accountService.getAccountByEntity(entityId, entityType);
      if (record) assertAccountAccess(record, ownershipFromRequest(req));
    }

    if (!record) return error(res, 'Account not found', 404);
    return success(res, record);
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Account access denied', err.statusCode);
    }
    next(err);
  }
};

const getAccountById = async (req, res, next) => {
  try {
    const record = await loadAccountForUser(req, req.params.id);
    return success(res, record);
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Account not found', err.statusCode);
    }
    next(err);
  }
};

const updateAccount = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    const record = await accountService.updateAccount(req.params.id, req.body, ctx(req));
    return success(res, record, 'Account updated');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to update account', err.statusCode);
    }
    next(err);
  }
};

const syncAccount = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    const record = await accountService.syncAccount(req.params.id, ctx(req));
    return success(res, record, 'Account synced');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to sync account', err.statusCode);
    }
    next(err);
  }
};

const deleteAccount = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    await accountService.deleteAccount(req.params.id, ctx(req));
    return success(res, null, 'Account deleted');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to delete account', err.statusCode);
    }
    next(err);
  }
};

// ── Webhook ───────────────────────────────────────────────────────────────────

const handleAccountWebhook = async (req, res, next) => {
  try {
    const payload = req.body;
    const correlationId = req.headers['x-correlation-id'] || null;

    logger.info('[AccountController] Webhook received', {
      eventId:   payload.event_id,
      eventType: payload.event_type,
      accountId: payload.account_id,
    });

    const result = await webhookService.process(payload, {
      rawBody:         req.rawBody || null,
      signatureHeader: req.headers['straddle-signature'] || req.headers['x-straddle-signature'] || null,
      timestampHeader: req.headers['straddle-timestamp'] || null,
      correlationId,
    });

    if (result.duplicate) {
      return res.status(200).json({ received: true, message: 'Duplicate event' });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[AccountController] Webhook failed', {
      eventId: req.body?.event_id,
      error:   err.message,
    });
    if (err.statusCode === 401 || err.statusCode === 400) {
      return res.status(200).json({ received: false, message: err.message });
    }
    next(err);
  }
};

// ── Linked Bank Account sub-resources (Embed) ─────────────────────────────────
// Customer paykey banks remain on /api/v1/payments/bank-accounts - untouched.

const addBankToAccount = async (req, res, next) => {
  try {
    const bank = await linkedBankService.createLinkedBank(req.params.id, req.body, bankOwnership(req));
    logger.info('[AccountController] addBankToAccount', {
      accountId: req.params.id,
      bankId: bank._id,
      linkedBankAccountId: bank.linkedBankAccountId,
    });
    return success(res, toBankDto(bank), 'Linked bank account added', 201);
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to add linked bank account', err.statusCode);
    }
    next(err);
  }
};

const listBanksForAccount = async (req, res, next) => {
  try {
    const banks = await linkedBankService.listLinkedBanks(req.params.id, bankOwnership(req));
    return success(res, banks.map(toBankDto));
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message, err.statusCode);
    }
    next(err);
  }
};

const getBankForAccount = async (req, res, next) => {
  try {
    const bank = await linkedBankService.getLinkedBank(req.params.id, req.params.bankId, bankOwnership(req));
    return success(res, toBankDto(bank));
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message, err.statusCode);
    }
    next(err);
  }
};

const deleteBankFromAccount = async (req, res, next) => {
  try {
    await linkedBankService.cancelLinkedBank(req.params.id, req.params.bankId, bankOwnership(req));
    logger.info('[AccountController] deleteBankFromAccount', {
      accountId: req.params.id,
      bankId: req.params.bankId,
    });
    return success(res, null, 'Linked bank account removed');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message, err.statusCode);
    }
    next(err);
  }
};

const updateBankOnAccount = async (req, res, next) => {
  try {
    const bank = await linkedBankService.updateLinkedBank(
      req.params.id,
      req.params.bankId,
      req.body,
      bankOwnership(req)
    );
    logger.info('[AccountController] updateBankOnAccount', {
      accountId: req.params.id,
      bankId: req.params.bankId,
    });
    return success(res, toBankDto(bank), 'Linked bank account updated');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to update linked bank account', err.statusCode);
    }
    next(err);
  }
};

/** Sync verification/status from Straddle (replaces local-only "verify") */
const verifyBankOnAccount = async (req, res, next) => {
  try {
    const bank = await linkedBankService.syncLinkedBank(req.params.id, req.params.bankId, bankOwnership(req));
    return success(res, toBankDto(bank), 'Linked bank account synced');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message, err.statusCode);
    }
    next(err);
  }
};

const createBridgeSessionForAccount = async (req, res, next) => {
  // Bridge/paykey verification is for Customer banks, not Embed Linked Bank Accounts.
  return error(
    res,
    'Bridge verification is not used for linked bank accounts. Use Sync to refresh Straddle status.',
    400
  );
};

const listRepresentativesForAccount = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    const reps = await representativeService.listRepresentatives(req.params.id, bankOwnership(req));
    return success(res, reps);
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message, err.statusCode);
    }
    next(err);
  }
};

const addRepresentativeToAccount = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    const rep = await representativeService.createRepresentative(req.params.id, req.body, bankOwnership(req));
    return success(res, rep, 'Representative added', 201);
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to add representative', err.statusCode);
    }
    next(err);
  }
};

const updateRepresentativeOnAccount = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    const rep = await representativeService.updateRepresentative(
      req.params.id,
      req.params.repId,
      req.body,
      bankOwnership(req)
    );
    return success(res, rep, 'Representative updated');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to update representative', err.statusCode);
    }
    next(err);
  }
};

const updateOnboardingStep = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    const record = await accountService.updateOnboardingWizardStep(req.params.id, req.body.step, ctx(req));
    return success(res, record, 'Onboarding progress saved');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message, err.statusCode);
    }
    next(err);
  }
};

const submitAccountOnboarding = async (req, res, next) => {
  try {
    await loadAccountForUser(req, req.params.id);
    const record = await accountService.submitOnboarding(
      req.params.id,
      {
        acceptedUserAgent: req.headers['user-agent'] || null,
        agreementUrl: req.body.agreementUrl || null,
      },
      {
        ...ctx(req),
        clientIp: clientIp(req),
      }
    );
    const message = straddleConfig.isStraddleSandbox()
      ? 'Sandbox onboarding completed (capabilities + simulate)'
      : 'Onboarding submitted';
    return success(res, record, message);
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message || 'Failed to submit onboarding', err.statusCode);
    }
    next(err);
  }
};

const getOnboardingEnvironment = async (req, res) => {
  const sandbox = straddleConfig.isStraddleSandbox();
  return success(res, {
    sandbox,
    useSimulateOnboarding: sandbox,
    capabilityRequestPath: 'POST /v1/accounts/{account_id}/capability_requests',
    productionOnboardPath: 'POST /v1/accounts/{account_id}/onboard',
    sandboxSimulatePath: 'POST /v1/accounts/{account_id}/simulate?final_status=onboarding then final_status=active',
  });
};

const setPrimaryBankOnAccount = async (req, res, next) => {
  try {
    const bank = await linkedBankService.setPrimaryLinkedBank(
      req.params.id,
      req.params.bankId,
      bankOwnership(req)
    );
    return success(res, toBankDto(bank), 'Primary bank updated');
  } catch (err) {
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
      return error(res, err.message, err.statusCode);
    }
    next(err);
  }
};

module.exports = {
  createAccount,
  listAccounts,
  getAccountByEntity,
  getAccountById,
  updateAccount,
  syncAccount,
  deleteAccount,
  handleAccountWebhook,
  addBankToAccount,
  listBanksForAccount,
  getBankForAccount,
  deleteBankFromAccount,
  updateBankOnAccount,
  verifyBankOnAccount,
  createBridgeSessionForAccount,
  listRepresentativesForAccount,
  addRepresentativeToAccount,
  updateRepresentativeOnAccount,
  updateOnboardingStep,
  submitAccountOnboarding,
  getOnboardingEnvironment,
  setPrimaryBankOnAccount,
};
