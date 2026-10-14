'use strict';

const responseHelper = require('../../../../../../common/helpers/responseHelper');
const {
  initializeMerchantOnboarding,
  registerMerchantFromProcessingAccount,
  getMerchantOnboardingStatus,
  listMerchantAccounts,
  findAccountById,
  assertPayloadMerchantAccess,
  syncPayloadAccountFromRemote,
  simulateSandboxMerchantApproval,
} = require('../service/payloadMerchant.service');
const {
  createMerchantOnboardingSession,
  createProcessingAccountPluginToken,
} = require('../service/payloadComponentSession.service');
const {
  initializePaymentMethodSetup,
  initializePaymentMethodEditSetup,
  registerPaymentMethodFromComponent,
  deletePaymentMethodForUser,
  updatePaymentMethodForUser,
  listUserPaymentMethods,
  resolveBillableMerchantForUser,
} = require('../service/payloadPaymentMethod.service');
const {
  executeInvoicePayin,
  getPayinForUser,
  validatePayinAllocations,
} = require('../service/payloadPayin.service');
const {
  requestInvoicePaymentRefund,
  getRefundForBoard,
} = require('../service/payloadRefund.service');
const {
  runPayloadReconciliation,
} = require('../service/payloadReconciliation.service');
const {
  retryFailedPayloadWebhooks,
} = require('../service/payloadWebhookRetry.service');
const {
  listDepositMethodsForAccount,
  syncDepositMethodsForAccount,
  getMerchantDetail,
  initializeDepositMethodSetup,
  registerDepositMethodFromComponent,
  setPrimaryDepositMethod,
} = require('../service/payloadDepositMethod.service');
const { ingestPayloadWebhook } = require('../service/payloadWebhook.service');
const { ENTITY_TYPE, MERCHANT_ONBOARDING_STATUS } = require('../constants/payload.constants');
const payloadConfig = require('../../../../../../config/payload.config');
const { toUserFriendlyPayloadMessage } = require('../utils/payloadUserError.util');
const { httpStatusForPayloadUpstreamError } = require('../utils/payloadHttpStatus.util');
const logger = require('../../../../../../common/logger');

function respondPayloadError(res, err, fallbackMessage) {
  const upstreamStatus = err?.statusCode || err?.status || 500;
  const httpStatus = httpStatusForPayloadUpstreamError(upstreamStatus);
  const message = toUserFriendlyPayloadMessage(upstreamStatus, err?.message || fallbackMessage);
  return responseHelper.error(res, message, httpStatus);
}

function resolveBusinessId(req) {
  const userId = req.userId || req.user?._id || null;
  return req.user?.companyId || req.body?.businessId || req.query?.businessId || userId;
}

function resolveUserId(req) {
  return req.userId || req.user?._id || null;
}

const getPublicConfig = async (_req, res) => {
  return responseHelper.success(res, {
    enabled: payloadConfig.payload.enabled,
    environment: payloadConfig.payload.environment,
    isSandbox: require('../../../../../../config/payload.config').isPayloadSandbox(),
    termsAndConditionsUrl: payloadConfig.payload.termsAndConditionsUrl || process.env.PAYLOAD_TERMS_URL || '',
    ownerAutopayEnabled: !!payloadConfig.payload.ownerAutopayEnabled,
    check21Enabled: !!payloadConfig.payload.check21Enabled,
    /** Phase 1: Vendor Portal Payload Processing Account onboarding */
    vendorMerchantEnabled: !!payloadConfig.payload.vendorMerchantEnabled,
    /** Phase 4: Owner → Vendor electronic pay (default false; sandbox ≠ production-ready) */
    vendorPayEnabled: !!payloadConfig.payload.vendorPayEnabled,
  }, 'Payload configuration', 200);
};

const listMerchants = async (req, res) => {
  try {
    const { entityType, entityId, hoaId } = req.query || {};
    const businessId = resolveBusinessId(req);
    const userId = resolveUserId(req);

    if (entityType === ENTITY_TYPE.VENDOR) {
      const {
        assertVendorMerchantFeatureEnabled,
        assertVendorMerchantActor,
      } = require('../service/payloadMerchant.service');
      assertVendorMerchantFeatureEnabled();
      assertVendorMerchantActor(req);
    }

    const accounts = await listMerchantAccounts({
      entityType,
      businessId,
      createdBy:
        entityType === ENTITY_TYPE.HOA || entityType === ENTITY_TYPE.VENDOR
          ? userId
          : undefined,
      hoaId: hoaId || (entityType === ENTITY_TYPE.HOA ? entityId : undefined),
    });

    return responseHelper.success(res, { accounts }, 'Business Merchant Account', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to list Business Merchant Account.');
  }
};

const registerMerchantProcessingAccount = async (req, res) => {
  try {
    const { accountId } = req.params || {};
    const { processingAccountId } = req.body || {};
    const account = await registerMerchantFromProcessingAccount({
      accountId,
      processingAccountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { account }, 'Payload processing account linked', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to link Payload processing account.');
  }
};

const initializeMerchant = async (req, res) => {
  try {
    const { entityType, entityId, accountName, merchantName } = req.body || {};
    const businessId = resolveBusinessId(req);
    const result = await initializeMerchantOnboarding({
      entityType,
      entityId,
      businessId,
      accountName,
      merchantName,
      createdBy: resolveUserId(req),
      req,
    });
    const account = result?.account || result;
    const requiresPlugin = result?.requiresPayloadProcessingAccount;

    let onboarding = null;
    if (requiresPlugin) {
      try {
        const session = await createProcessingAccountPluginToken();
        onboarding = {
          flow: 'plugin',
          clientToken: session.clientToken,
          expiresAt: session.expiresAt,
          mode: result?.onboardingMode || 'plugin',
        };
      } catch (tokenErr) {
        logger.error('[Payload] Failed to mint processing_account_plugin client token', {
          message: tokenErr?.message,
          status: tokenErr?.statusCode,
        });
        onboarding = {
          flow: 'plugin',
          deferred: true,
          clientTokenError: toUserFriendlyPayloadMessage(
            tokenErr?.statusCode || 502,
            tokenErr?.message || 'Unable to start Payload onboarding token.',
          ),
          mode: result?.onboardingMode || 'plugin',
        };
      }
    } else if (account?.metadata?.payloadApplicationLink) {
      onboarding = {
        flow: 'application_link',
        applicationLinkUrl: account.metadata.payloadApplicationLink,
      };
    }

    return responseHelper.success(res, { account, onboarding }, 'Payload merchant onboarding prepared', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to create Business account.');
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
    return responseHelper.success(res, { account }, 'Payload merchant status', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to load Business account status.');
  }
};

const createMerchantSession = async (req, res) => {
  try {
    const { accountId } = req.body || {};
    const account = await findAccountById(accountId);
    if (!account) {
      return responseHelper.error(res, 'Business account not found. Create a business account first.', 404);
    }
    assertPayloadMerchantAccess(account, { businessId: resolveBusinessId(req), userId: resolveUserId(req) });
    await syncPayloadAccountFromRemote(account);
    const refreshed = await findAccountById(accountId);

    if (!refreshed?.merchantId) {
      const session = await createProcessingAccountPluginToken();
      return responseHelper.success(res, {
        flow: 'plugin',
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        accountId: String(refreshed._id),
        merchantId: '',
        merchantApplicationId: refreshed.merchantApplicationId || '',
        termsAndConditionsUrl: payloadConfig.payload.termsAndConditionsUrl || process.env.PAYLOAD_TERMS_URL || '',
      }, 'Payload processing account plugin session created', 200);
    }

    const useMerchantHub = refreshed?.onboardingStatus === MERCHANT_ONBOARDING_STATUS.ACTIVE;

    // Existing processing accounts (including ACTIVE "Edit merchant"): use Payload's
    // application_link for that processing_id. Do NOT mint processing_account_plugin
    // with nested processing_id — Payload rejects intent.processing_account_plugin
    // ("Not a valid field"); the plugin intent only supports { type: 'processing_account_plugin' }
    // for creating NEW accounts.
    const session = await createMerchantOnboardingSession({
      merchantId: refreshed.merchantId,
      // Always regenerate — do not reuse stale metadata.payloadApplicationLink.
      applicationLinkUrl: null,
    });

    const sessionKey = session.sessionKey || '';
    const flow = sessionKey.startsWith('http')
      ? 'application_link'
      : (useMerchantHub ? 'hub' : 'onboarding');

    return responseHelper.success(res, {
      flow,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      accountId: String(refreshed._id),
      merchantId: refreshed.merchantId,
      merchantApplicationId: refreshed.merchantApplicationId,
      termsAndConditionsUrl: payloadConfig.payload.termsAndConditionsUrl || process.env.PAYLOAD_TERMS_URL || '',
    }, 'Business onboarding session created', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to start Business onboarding.');
  }
};

const initializePaymentMethod = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { entityType, entityId, allowedMethods } = req.body || {};
    const businessId = resolveBusinessId(req);
    const setup = await initializePaymentMethodSetup({
      userId,
      billableMerchantId: req.body?.billableMerchantId,
      entityType,
      entityId,
      allowedMethods: allowedMethods || 'CARD,ACH',
      req,
    });

    return responseHelper.success(res, setup, 'Business payment method setup initialized', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to initialize Payload payment method setup.');
  }
};

const initializePaymentMethodEdit = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { localMethodId, entityType, entityId, allowedMethods } = req.body || {};
    const setup = await initializePaymentMethodEditSetup({
      userId,
      localMethodId,
      entityType,
      entityId,
      allowedMethods: allowedMethods || 'CARD,ACH',
      req,
    });
    return responseHelper.success(res, setup, 'Business payment method edit initialized', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to initialize Payload payment method edit.');
  }
};

const registerPaymentMethod = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const {
      paymentMethodId,
      paymentMethodConfigId,
      billableMerchantId,
      entityType,
      entityId,
    } = req.body || {};
    const item = await registerPaymentMethodFromComponent({
      userId,
      paymentMethodId,
      paymentMethodConfigId,
      billableMerchantId,
      entityType,
      entityId,
      req,
    });
    return responseHelper.success(res, { item }, 'Payload payment method registered', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to register Payload payment method.');
  }
};

const getPaymentMethods = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { entityType, entityId } = req.query || {};
    const items = await listUserPaymentMethods(userId, { entityType, entityId });
    return responseHelper.success(res, { items }, 'Payload payment methods', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to list Payload payment methods.');
  }
};

const deleteOwnerPaymentMethod = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { entityType, entityId } = req.body || {};
    const result = await deletePaymentMethodForUser({
      userId,
      localMethodId: req.params.methodId,
      entityType,
      entityId,
      req,
    });
    return responseHelper.success(res, result, 'Payload payment method removed', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to remove Payload payment method.');
  }
};

const updateOwnerPaymentMethod = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { description, isDefault, billingAddress, entityType, entityId } = req.body || {};
    const item = await updatePaymentMethodForUser({
      userId,
      localMethodId: req.params.methodId,
      description,
      isDefault,
      billingAddress,
      entityType,
      entityId,
      req,
    });
    return responseHelper.success(res, { item }, 'Payload payment method updated', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to update Payload payment method.');
  }
};

const handlePayloadWebhook = async (req, res) => {
  try {
    const result = await ingestPayloadWebhook({
      payload: req.body,
      signatureVerified: !!req.payloadSignatureVerified,
      rawBody: req.rawBody,
    });
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    return res.status(500).json({ received: false, message: err.message || 'Webhook processing failed.' });
  }
};

const getPayloadMerchantDetail = async (req, res) => {
  try {
    const detail = await getMerchantDetail({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
    });
    return responseHelper.success(res, detail, 'Payload merchant detail', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to load Payload merchant detail.');
  }
};

const listPayloadDepositMethods = async (req, res) => {
  try {
    const items = await listDepositMethodsForAccount({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
    });
    return responseHelper.success(res, { items }, 'Payload deposit bank accounts', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to list Payload deposit banks.');
  }
};

const syncPayloadDepositMethods = async (req, res) => {
  try {
    const items = await syncDepositMethodsForAccount({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { items }, 'Payload deposit banks synced', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to sync Payload deposit banks.');
  }
};

const initializePayloadDepositMethod = async (req, res) => {
  try {
    const { holderName } = req.body || {};
    const setup = await initializeDepositMethodSetup({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      holderName,
      req,
    });
    return responseHelper.success(res, setup, 'Payload deposit bank setup initialized', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to initialize Payload deposit bank setup.');
  }
};

const registerPayloadDepositMethod = async (req, res) => {
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
    return responseHelper.success(res, { item }, 'Payload deposit bank registered', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to register Payload deposit bank.');
  }
};

const setPrimaryPayloadDepositMethod = async (req, res) => {
  try {
    const item = await setPrimaryDepositMethod({
      accountId: req.params.accountId,
      depositMethodLocalId: req.params.depositMethodId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { item }, 'Primary Payload payout bank updated', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to update primary Payload payout bank.');
  }
};

const simulatePayloadMerchantApproval = async (req, res) => {
  try {
    const account = await simulateSandboxMerchantApproval({
      accountId: req.params.accountId,
      businessId: resolveBusinessId(req),
      userId: resolveUserId(req),
      req,
    });
    return responseHelper.success(res, { account }, 'Payload merchant approved (sandbox simulation)', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to simulate Payload merchant approval.');
  }
};

const executePayloadPayin = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const {
      invoiceId,
      invoicePaymentAmount,
      chargeAmount,
      paymentMethodId,
      paymentAttemptId,
      description,
      skipPayerFeeAutofill,
      coveredInvoiceIds,
    } = req.body || {};

    const result = await executeInvoicePayin({
      userId,
      invoiceId,
      invoicePaymentAmount,
      chargeAmount,
      paymentMethodId,
      paymentAttemptId,
      description,
      skipPayerFeeAutofill: Boolean(skipPayerFeeAutofill),
      coveredInvoiceIds: Array.isArray(coveredInvoiceIds) ? coveredInvoiceIds : [],
      req,
    });

    return responseHelper.success(res, result, 'Payload payin submitted', result.duplicate ? 200 : 201);
  } catch (err) {
    return responseHelper.error(
      res,
      toUserFriendlyPayloadMessage(err.statusCode || 500, err.message || 'Unable to process Payload payment.'),
      err.statusCode || 500,
      err.details || null
    );
  }
};

const getPayloadPayin = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const item = await getPayinForUser({
      userId,
      payinRef: req.params.payinId,
    });
    return responseHelper.success(res, { item }, 'Payload payin', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to load Payload payin.');
  }
};

const validatePayloadPayinAllocations = async (req, res) => {
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
    return respondPayloadError(res, err, 'Unable to validate Payload payin allocations.');
  }
};

const requestPayloadRefund = async (req, res) => {
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
      result.duplicate ? 'Payload refund already submitted' : 'Payload refund submitted',
      result.duplicate ? 200 : 201
    );
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to submit Payload refund.');
  }
};

const getPayloadRefund = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const item = await getRefundForBoard({
      userId,
      refundRef: req.params.refundId,
      req,
    });
    return responseHelper.success(res, { item }, 'Payload refund', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to load Payload refund.');
  }
};

const runPayloadReconciliationHandler = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { hoaId, since, limit, includeFailedWebhooks } = req.query || {};
    const result = await runPayloadReconciliation({
      userId,
      hoaId,
      since,
      limit,
      includeFailedWebhooks: includeFailedWebhooks !== 'false',
      req,
    });
    return responseHelper.success(res, result, 'Payload reconciliation scan complete', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to run Payload reconciliation.');
  }
};

const retryPayloadWebhooks = async (req, res) => {
  try {
    const result = await retryFailedPayloadWebhooks();
    return responseHelper.success(res, result, 'Payload webhook retry batch complete', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to retry Payload webhooks.');
  }
};

const {
  getOwnerAutopayStatus,
  enableOwnerAutopay,
  disableOwnerAutopay,
  changeOwnerAutopayPaymentMethod,
} = require('../service/payloadAutopay.service');

const getPayloadOwnerAutopay = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { hoaId } = req.query || {};
    const item = await getOwnerAutopayStatus({ userId, hoaId });
    return responseHelper.success(res, { item }, 'Owner autopay status', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to load Auto Pay status.');
  }
};

const enablePayloadOwnerAutopay = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { hoaId, paymentMethodLocalId, confirmAutopay } = req.body || {};
    const item = await enableOwnerAutopay({
      userId,
      hoaId,
      paymentMethodLocalId,
      confirmAutopay,
      req,
    });
    return responseHelper.success(res, { item }, 'Auto Pay enabled', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to enable Auto Pay.');
  }
};

const disablePayloadOwnerAutopay = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { hoaId } = req.body || {};
    const item = await disableOwnerAutopay({ userId, hoaId, req });
    return responseHelper.success(res, { item }, 'Auto Pay disabled', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to disable Auto Pay.');
  }
};

const changePayloadOwnerAutopayPaymentMethod = async (req, res) => {
  try {
    const userId = resolveUserId(req);
    const { hoaId, paymentMethodLocalId } = req.body || {};
    const item = await changeOwnerAutopayPaymentMethod({
      userId,
      hoaId,
      paymentMethodLocalId,
      req,
    });
    return responseHelper.success(res, { item }, 'Auto Pay payment method updated', 200);
  } catch (err) {
    return respondPayloadError(res, err, 'Unable to update Auto Pay payment method.');
  }
};

const submitPayloadCheck21ForInvoice = async (req, res) => {
  const {
    toCheck21UserFriendlyMessage,
    sanitizePayloadErrorForLog,
  } = require('../utils/payloadCheck21.util');
  try {
    const {
      submitCheck21ForInvoice,
    } = require('../service/payloadCheck21Payin.service');
    const userId = resolveUserId(req);
    const invoiceId = req.body?.invoiceId;
    const amount = req.body?.amount;
    const paymentAttemptId = req.body?.paymentAttemptId || '';
    const accountId = req.body?.accountId || null;
    const description = req.body?.description || '';
    const frontFile = req.files?.front?.[0] || null;
    const backFile = req.files?.back?.[0] || null;

    if (!invoiceId || !/^[a-fA-F0-9]{24}$/.test(String(invoiceId))) {
      return responseHelper.error(res, 'Valid invoiceId is required.', 400);
    }
    if (!frontFile || !backFile) {
      return responseHelper.error(
        res,
        'Both front and back check images are required for Check21.',
        400,
      );
    }
    if (amount == null || amount === '') {
      return responseHelper.error(res, 'Amount is required.', 400);
    }

    const result = await submitCheck21ForInvoice({
      userId,
      businessId: resolveBusinessId(req),
      invoiceId,
      proposedAmount: amount,
      paymentAttemptId,
      accountId,
      frontFile,
      backFile,
      description,
      req,
    });

    return responseHelper.success(
      res,
      result,
      result.message || 'Check submitted — processing',
      result.duplicate ? 200 : 201,
    );
  } catch (err) {
    const upstreamStatus = err?.statusCode || err?.status || 500;
    const httpStatus = httpStatusForPayloadUpstreamError(upstreamStatus);
    const message = err?.isCheck21Error
      ? (err.message || 'Unable to submit Check21 payment.')
      : toCheck21UserFriendlyMessage(
        upstreamStatus,
        err?.message || 'Unable to submit Check21 payment.',
        err?.payloadError,
      );
    if (err?.payloadError) {
      logger.warn('[Check21] Controller error', {
        status: upstreamStatus,
        payloadError: sanitizePayloadErrorForLog(err.payloadError),
      });
    }
    return responseHelper.error(res, message, httpStatus);
  }
};

const getVendorInvoicePayEligibility = async (req, res) => {
  try {
    const { getVendorInvoicePayEligibility: resolveEligibility } = require(
      '../service/payloadVendorEligibility.service',
    );
    const vendorInvoiceId = req.params?.vendorInvoiceId;
    const data = await resolveEligibility({
      vendorInvoiceId,
      actorId: resolveUserId(req),
      hoaContext: req.hoaContext || null,
    });
    return responseHelper.success(res, data, 'Vendor invoice pay eligibility', 200);
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    if (status === 403 || status === 404) {
      return responseHelper.error(res, err.message || 'Unable to resolve eligibility.', status);
    }
    return respondPayloadError(res, err, 'Unable to resolve Vendor invoice pay eligibility.');
  }
};

const validateVendorInvoicePayin = async (req, res) => {
  try {
    const { validateVendorInvoicePayin: validate } = require('../service/payloadVendorPayin.service');
    const data = await validate({
      vendorInvoiceId: req.params?.vendorInvoiceId,
      actorId: resolveUserId(req),
      hoaContext: req.hoaContext || null,
      invoicePaymentAmount: req.body?.invoicePaymentAmount,
      paymentMethodLocalId: req.body?.paymentMethodLocalId,
    });
    return responseHelper.success(res, data, 'Vendor invoice payin validation', 200);
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    if (status === 400 || status === 403 || status === 404 || status === 409) {
      return responseHelper.error(res, err.message || 'Validation failed.', status);
    }
    return respondPayloadError(res, err, 'Unable to validate Vendor invoice payin.');
  }
};

const executeVendorInvoicePayin = async (req, res) => {
  try {
    const { executeVendorInvoicePayin: execute } = require('../service/payloadVendorPayin.service');
    const data = await execute({
      vendorInvoiceId: req.params?.vendorInvoiceId,
      actorId: resolveUserId(req),
      hoaContext: req.hoaContext || null,
      invoicePaymentAmount: req.body?.invoicePaymentAmount,
      paymentMethodLocalId: req.body?.paymentMethodLocalId,
      paymentAttemptId: req.body?.paymentAttemptId,
      description: req.body?.description || '',
    });
    return responseHelper.success(res, data, 'Vendor invoice payin', 200);
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    if (status === 400 || status === 403 || status === 404 || status === 409) {
      return responseHelper.error(res, err.message || 'Unable to execute Vendor payin.', status);
    }
    return respondPayloadError(res, err, 'Unable to execute Vendor invoice payin.');
  }
};

const getVendorPayin = async (req, res) => {
  try {
    const { getVendorPayinById } = require('../service/payloadVendorPayin.service');
    const data = await getVendorPayinById({
      vendorPayinId: req.params?.vendorPayinId,
      actorId: resolveUserId(req),
      hoaContext: req.hoaContext || null,
    });
    return responseHelper.success(res, data, 'Vendor payin', 200);
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    if (status === 400 || status === 403 || status === 404) {
      return responseHelper.error(res, err.message || 'Vendor payin not found.', status);
    }
    return respondPayloadError(res, err, 'Unable to load Vendor payin.');
  }
};

module.exports = {
  getPublicConfig,
  listMerchants,
  initializeMerchant,
  registerMerchantProcessingAccount,
  getMerchantStatus,
  createMerchantSession,
  simulatePayloadMerchantApproval,
  getPayloadMerchantDetail,
  listPayloadDepositMethods,
  syncPayloadDepositMethods,
  initializePayloadDepositMethod,
  registerPayloadDepositMethod,
  setPrimaryPayloadDepositMethod,
  initializePaymentMethod,
  initializePaymentMethodEdit,
  registerPaymentMethod,
  getPaymentMethods,
  updateOwnerPaymentMethod,
  deleteOwnerPaymentMethod,
  getVendorInvoicePayEligibility,
  validateVendorInvoicePayin,
  executeVendorInvoicePayin,
  getVendorPayin,
  executePayloadPayin,
  validatePayloadPayinAllocations,
  getPayloadPayin,
  requestPayloadRefund,
  getPayloadRefund,
  runPayloadReconciliation: runPayloadReconciliationHandler,
  retryPayloadWebhooks,
  handlePayloadWebhook,
  getPayloadOwnerAutopay,
  enablePayloadOwnerAutopay,
  disablePayloadOwnerAutopay,
  changePayloadOwnerAutopayPaymentMethod,
  submitPayloadCheck21ForInvoice,
};
