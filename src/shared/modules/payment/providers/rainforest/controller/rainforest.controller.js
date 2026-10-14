'use strict';

const responseHelper = require('../../../../../../common/helpers/responseHelper');
const {
  initializeMerchantOnboarding,
  getMerchantOnboardingStatus,
  listMerchantAccounts,
  findAccountById,
  assertRainforestMerchantAccess,
  syncRainforestAccountFromRemote,
  simulateSandboxMerchantApproval,
} = require('../service/rainforestMerchant.service');
const {
  createMerchantHubSession,
  createMerchantOnboardingSession,
} = require('../service/rainforestComponentSession.service');
const {
  initializePaymentMethodSetup,
  registerPaymentMethodFromComponent,
  listUserPaymentMethods,
  resolveBillableMerchantForUser,
} = require('../service/rainforestPaymentMethod.service');
const {
  executeInvoicePayin,
  getPayinForUser,
  validatePayinAllocations,
} = require('../service/rainforestPayin.service');
const {
  requestInvoicePaymentRefund,
  getRefundForBoard,
} = require('../service/rainforestRefund.service');
const {
  runRainforestReconciliation,
} = require('../service/rainforestReconciliation.service');
const {
  retryFailedRainforestWebhooks,
} = require('../service/rainforestWebhookRetry.service');
const {
  listDepositMethodsForAccount,
  syncDepositMethodsForAccount,
  getMerchantDetail,
  initializeDepositMethodSetup,
  registerDepositMethodFromComponent,
  setPrimaryDepositMethod,
} = require('../service/rainforestDepositMethod.service');
const { ingestRainforestWebhook } = require('../service/rainforestWebhook.service');
const { ENTITY_TYPE, MERCHANT_ONBOARDING_STATUS } = require('../constants/rainforest.constants');
const rainforestConfig = require('../../../../../../config/rainforest.config');
const { toUserFriendlyRainforestMessage } = require('../utils/rainforestUserError.util');

function resolveBusinessId(req) {
  const userId = req.userId || req.user?._id || null;
  return req.user?.companyId || req.body?.businessId || req.query?.businessId || userId;
}

function resolveUserId(req) {
  return req.userId || req.user?._id || null;
}

const getPublicConfig = async (_req, res) => {
  return responseHelper.success(res, {
    enabled: rainforestConfig.rainforest.enabled,
    environment: rainforestConfig.rainforest.environment,
    isSandbox: require('../../../../../../config/rainforest.config').isRainforestSandbox(),
    termsAndConditionsUrl: rainforestConfig.rainforest.termsAndConditionsUrl || process.env.RAINFOREST_TERMS_URL || '',
  }, 'Rainforest configuration', 200);
};

const listMerchants = async (req, res) => {
  try {
    const { entityType, entityId, hoaId } = req.query || {};
    const businessId = resolveBusinessId(req);
    const userId = resolveUserId(req);

    const accounts = await listMerchantAccounts({
      entityType,
      businessId,
      createdBy: entityType === ENTITY_TYPE.HOA ? userId : undefined,
      hoaId: hoaId || (entityType === ENTITY_TYPE.HOA ? entityId : undefined),
    });

    return responseHelper.success(res, { accounts }, 'Business Merchant Account', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to list Business Merchant Account.'),
      err.statusCode || 500
    );
  }
};

const initializeMerchant = async (req, res) => {
  try {
    const { entityType, entityId, accountName, merchantName } = req.body || {};
    const businessId = resolveBusinessId(req);
    const account = await initializeMerchantOnboarding({
      entityType,
      entityId,
      businessId,
      accountName,
      merchantName,
      createdBy: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { account }, 'Rainforest merchant account created', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to create Business account.'),
      err.statusCode || 500
    );
  }
};

const getMerchantStatus = async (req, res) => {
  try {
    const { accountId } = req.query || {};
    const account = await getMerchantOnboardingStatus({
      accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
    });
    return responseHelper.success(res, { account }, 'Rainforest merchant status', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to load Business account status.'),
      err.statusCode || 500
    );
  }
};

const createMerchantSession = async (req, res) => {
  try {
    const { accountId } = req.body || {};
    const account = await findAccountById(accountId);
    if (!account?.merchantId) {
      return responseHelper.error(res, 'Business account not found. Create a business account first.', 404);
    }
    assertRainforestMerchantAccess(account, { businessId: resolveBusinessId(req), userId: resolveUserId(req) });
    await syncRainforestAccountFromRemote(account);
    const refreshed = await findAccountById(accountId);

    const useMerchantHub = refreshed?.onboardingStatus === MERCHANT_ONBOARDING_STATUS.ACTIVE;
    const session = useMerchantHub
      ? await createMerchantHubSession({ merchantId: refreshed.merchantId })
      : await createMerchantOnboardingSession({ merchantId: refreshed.merchantId });

    return responseHelper.success(res, {
      flow: useMerchantHub ? 'hub' : 'onboarding',
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      accountId: String(refreshed._id),
      merchantId: refreshed.merchantId,
      merchantApplicationId: refreshed.merchantApplicationId,
      termsAndConditionsUrl: rainforestConfig.rainforest.termsAndConditionsUrl || process.env.RAINFOREST_TERMS_URL || '',
    }, 'Business onboarding session created', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to start Business onboarding.'),
      err.statusCode || 500
    );
  }
};

const initializePaymentMethod = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { entityType, entityId, allowedMethods } = req.body || {};
    const businessId = resolveBusinessId(req);
    const billableMerchantId =
      req.body?.billableMerchantId
      || await resolveBillableMerchantForUser({ userId, entityType, entityId, businessId });

    const setup = await initializePaymentMethodSetup({
      userId,
      billableMerchantId,
      entityType,
      entityId,
      allowedMethods: allowedMethods || 'CARD,ACH',
      req,
    });

    return responseHelper.success(res, setup, 'Business payment method setup initialized', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to initialize Rainforest payment method setup.'),
      err.statusCode || 500
    );
  }
};

const registerPaymentMethod = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { paymentMethodId, paymentMethodConfigId, billableMerchantId } = req.body || {};
    const item = await registerPaymentMethodFromComponent({
      userId,
      paymentMethodId,
      paymentMethodConfigId,
      billableMerchantId,
      req,
    });
    return responseHelper.success(res, { item }, 'Rainforest payment method registered', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to register Rainforest payment method.'),
      err.statusCode || 500
    );
  }
};

const getPaymentMethods = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const items = await listUserPaymentMethods(userId);
    return responseHelper.success(res, { items }, 'Rainforest payment methods', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to list Rainforest payment methods.'),
      err.statusCode || 500
    );
  }
};

const handleRainforestWebhook = async (req, res) => {
  try {
    const result = await ingestRainforestWebhook({
      payload: req.body,
      signatureVerified: !!req.rainforestSignatureVerified,
      rawBody: req.rawBody,
    });
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    return res.status(500).json({ received: false, message: err.message || 'Webhook processing failed.' });
  }
};

const getRainforestMerchantDetail = async (req, res) => {
  try {
    const detail = await getMerchantDetail({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
    });
    return responseHelper.success(res, detail, 'Rainforest merchant detail', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to load Rainforest merchant detail.'),
      err.statusCode || 500
    );
  }
};

const listRainforestDepositMethods = async (req, res) => {
  try {
    const items = await listDepositMethodsForAccount({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
    });
    return responseHelper.success(res, { items }, 'Rainforest deposit bank accounts', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to list Rainforest deposit banks.'),
      err.statusCode || 500
    );
  }
};

const syncRainforestDepositMethods = async (req, res) => {
  try {
    const items = await syncDepositMethodsForAccount({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { items }, 'Rainforest deposit banks synced', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to sync Rainforest deposit banks.'),
      err.statusCode || 500
    );
  }
};

const initializeRainforestDepositMethod = async (req, res) => {
  try {
    const { holderName } = req.body || {};
    const setup = await initializeDepositMethodSetup({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      holderName,
      req,
    });
    return responseHelper.success(res, setup, 'Rainforest deposit bank setup initialized', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to initialize Rainforest deposit bank setup.'),
      err.statusCode || 500
    );
  }
};

const registerRainforestDepositMethod = async (req, res) => {
  try {
    const { depositMethodId, depositMethodConfigId, setAsPrimary } = req.body || {};
    const item = await registerDepositMethodFromComponent({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      depositMethodId,
      depositMethodConfigId,
      setAsPrimary: !!setAsPrimary,
      req,
    });
    return responseHelper.success(res, { item }, 'Rainforest deposit bank registered', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to register Rainforest deposit bank.'),
      err.statusCode || 500
    );
  }
};

const setPrimaryRainforestDepositMethod = async (req, res) => {
  try {
    const item = await setPrimaryDepositMethod({
      accountId: req.params.accountId,
      depositMethodLocalId: req.params.depositMethodId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { item }, 'Primary Rainforest payout bank updated', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to update primary Rainforest payout bank.'),
      err.statusCode || 500
    );
  }
};

const simulateRainforestMerchantApproval = async (req, res) => {
  try {
    const account = await simulateSandboxMerchantApproval({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { account }, 'Rainforest merchant approved (sandbox simulation)', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to simulate Rainforest merchant approval.'),
      err.statusCode || 500
    );
  }
};

const executeRainforestPayin = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const {
      invoiceId,
      invoicePaymentAmount,
      chargeAmount,
      paymentMethodId,
      paymentAttemptId,
      description,
    } = req.body || {};

    const result = await executeInvoicePayin({
      userId,
      invoiceId,
      invoicePaymentAmount,
      chargeAmount,
      paymentMethodId,
      paymentAttemptId,
      description,
      req,
    });

    return responseHelper.success(res, result, 'Rainforest payin submitted', result.duplicate ? 200 : 201);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to process Rainforest payment.'),
      err.statusCode || 500,
      err.details || null
    );
  }
};

const getRainforestPayin = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const item = await getPayinForUser({
      userId,
      payinRef: req.params.payinId,
    });
    return responseHelper.success(res, { item }, 'Rainforest payin', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to load Rainforest payin.'),
      err.statusCode || 500
    );
  }
};

const validateRainforestPayinAllocations = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { paymentMethodId, allocations } = req.body || {};
    const result = await validatePayinAllocations({
      userId,
      paymentMethodId,
      allocations,
    });
    return responseHelper.success(res, result, result.valid ? 'Payin allocations valid' : 'Payin allocations invalid', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to validate Rainforest payin allocations.'),
      err.statusCode || 500
    );
  }
};

const requestRainforestRefund = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const {
      invoiceId,
      paymentTransactionId,
      amount,
      reason,
      refundAttemptId,
    } = req.body || {};

    const result = await requestInvoicePaymentRefund({
      userId,
      invoiceId,
      paymentTransactionId,
      amount,
      reason,
      refundAttemptId,
      req,
    });

    return responseHelper.success(
      res,
      result,
      result.duplicate ? 'Rainforest refund already submitted' : 'Rainforest refund submitted',
      result.duplicate ? 200 : 201
    );
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to submit Rainforest refund.'),
      err.statusCode || 500
    );
  }
};

const getRainforestRefund = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const item = await getRefundForBoard({
      userId,
      refundRef: req.params.refundId,
      req,
    });
    return responseHelper.success(res, { item }, 'Rainforest refund', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to load Rainforest refund.'),
      err.statusCode || 500
    );
  }
};

const runRainforestReconciliationHandler = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { hoaId, since, limit, includeFailedWebhooks } = req.query || {};
    const result = await runRainforestReconciliation({
      userId,
      hoaId,
      since,
      limit,
      includeFailedWebhooks: includeFailedWebhooks !== 'false',
      req,
    });
    return responseHelper.success(res, result, 'Rainforest reconciliation scan complete', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to run Rainforest reconciliation.'),
      err.statusCode || 500
    );
  }
};

const retryRainforestWebhooks = async (req, res) => {
  try {
    const result = await retryFailedRainforestWebhooks();
    return responseHelper.success(res, result, 'Rainforest webhook retry batch complete', 200);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyRainforestMessage(err.statusCode || 500, err.message || 'Unable to retry Rainforest webhooks.'),
      err.statusCode || 500
    );
  }
};

module.exports = {
  getPublicConfig,
  listMerchants,
  initializeMerchant,
  getMerchantStatus,
  createMerchantSession,
  simulateRainforestMerchantApproval,
  getRainforestMerchantDetail,
  listRainforestDepositMethods,
  syncRainforestDepositMethods,
  initializeRainforestDepositMethod,
  registerRainforestDepositMethod,
  setPrimaryRainforestDepositMethod,
  initializePaymentMethod,
  registerPaymentMethod,
  getPaymentMethods,
  executeRainforestPayin,
  validateRainforestPayinAllocations,
  getRainforestPayin,
  requestRainforestRefund,
  getRainforestRefund,
  runRainforestReconciliation: runRainforestReconciliationHandler,
  retryRainforestWebhooks,
  handleRainforestWebhook,
};
