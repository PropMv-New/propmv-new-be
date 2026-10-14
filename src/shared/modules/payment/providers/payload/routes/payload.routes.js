'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../../../../../../middleware/auth');
const csrfProtection = require('../../../../../../middleware/csrfProtection');
const authorize = require('../../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../../middleware/lockCheck');
const { validateBody, validateQuery, validateParams } = require('../../../../../../middleware/requestValidator');
const requireAdministrator = require('../../../../../../middleware/requireAdministrator');
const controller = require('../controller/payload.controller');
const {
  initializeMerchantSchema,
  listMerchantsQuerySchema,
  merchantStatusQuerySchema,
  merchantSessionSchema,
  payloadAccountIdParamSchema,
  payloadDepositMethodIdParamSchema,
  initializeDepositMethodSchema,
  registerDepositMethodSchema,
  initializePaymentMethodSchema,
  initializePaymentMethodEditSchema,
  registerPaymentMethodSchema,
  executePayloadPayinSchema,
  validatePayloadPayinAllocationsSchema,
  payloadPayinIdParamSchema,
  requestPayloadRefundSchema,
  payloadRefundIdParamSchema,
  reconciliationQuerySchema,
  registerMerchantProcessingAccountSchema,
  listPaymentMethodsQuerySchema,
  payloadPaymentMethodLocalIdParamSchema,
  updateOwnerPaymentMethodSchema,
  deleteOwnerPaymentMethodSchema,
  ownerAutopayHoaQuerySchema,
  enableOwnerAutopaySchema,
  changeOwnerAutopayPaymentMethodSchema,
  disableOwnerAutopaySchema,
  vendorInvoicePayEligibilityParamSchema,
  validateVendorInvoicePayinBodySchema,
  executeVendorInvoicePayinBodySchema,
  vendorPayinIdParamSchema,
} = require('../validators/payload.validator');

const guard = [authMiddleware, authorize, lockCheckMiddleware];
const mutatingGuard = [csrfProtection, ...guard];

const multer = require('multer');
const { CHECK21_MAX_BYTES } = require('../utils/payloadCheck21.util');

const check21Upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHECK21_MAX_BYTES, files: 2 },
}).fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 },
]);

function runCheck21Upload(req, res, next) {
  check21Upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        message: 'Each check image must be under 10MB.',
        statuscode: 400,
        data: null,
      });
    }
    return res.status(400).json({
      message: err.message || 'Invalid check image upload.',
      statuscode: 400,
      data: null,
    });
  });
}

/** Simple in-memory rate limit for Check21 submit (per user). */
const check21RateBuckets = new Map();
function rateLimitCheck21Submit(req, res, next) {
  const userId = String(req.userId || req.user?._id || req.ip || 'anon');
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 10;
  let bucket = check21RateBuckets.get(userId);
  if (!bucket || now - bucket.windowStart > windowMs) {
    bucket = { windowStart: now, count: 0 };
    check21RateBuckets.set(userId, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return res.status(429).json({
      message: 'Too many Check21 submissions. Please wait a moment and try again.',
      statuscode: 429,
      data: null,
    });
  }
  return next();
}

/** Public Payload feature flag / non-secret config */
router.get('/config', controller.getPublicConfig);

/** Merchant onboarding (landlord / HOA entities) */
router.get('/merchants', ...guard, validateQuery(listMerchantsQuerySchema), controller.listMerchants);
router.post('/merchants/initialize', ...mutatingGuard, validateBody(initializeMerchantSchema), controller.initializeMerchant);
router.get('/merchants/status', ...guard, validateQuery(merchantStatusQuerySchema), controller.getMerchantStatus);
router.post('/merchants/onboarding-session', ...mutatingGuard, validateBody(merchantSessionSchema), controller.createMerchantSession);
router.post(
  '/merchants/:accountId/register-processing-account',
  ...mutatingGuard,
  validateParams(payloadAccountIdParamSchema),
  validateBody(registerMerchantProcessingAccountSchema),
  controller.registerMerchantProcessingAccount,
);
router.post('/merchants/:accountId/simulate-approval', ...mutatingGuard, validateParams(payloadAccountIdParamSchema), controller.simulatePayloadMerchantApproval);

/** Merchant detail + deposit bank accounts (Phase 2A–2C) */
router.get('/merchants/:accountId', ...guard, validateParams(payloadAccountIdParamSchema), controller.getPayloadMerchantDetail);
router.get('/merchants/:accountId/deposit-methods', ...guard, validateParams(payloadAccountIdParamSchema), controller.listPayloadDepositMethods);
router.post('/merchants/:accountId/deposit-methods/sync', ...mutatingGuard, validateParams(payloadAccountIdParamSchema), controller.syncPayloadDepositMethods);
router.post('/merchants/:accountId/deposit-methods/initialize', ...mutatingGuard, validateParams(payloadAccountIdParamSchema), validateBody(initializeDepositMethodSchema), controller.initializePayloadDepositMethod);
router.post('/merchants/:accountId/deposit-methods/register', ...mutatingGuard, validateParams(payloadAccountIdParamSchema), validateBody(registerDepositMethodSchema), controller.registerPayloadDepositMethod);
router.post('/merchants/:accountId/deposit-methods/:depositMethodId/set-primary', ...mutatingGuard, validateParams(payloadDepositMethodIdParamSchema), controller.setPrimaryPayloadDepositMethod);

/** Payor saved payment methods (tenant / HOA owner) */
router.post('/payment-methods/initialize', ...mutatingGuard, validateBody(initializePaymentMethodSchema), controller.initializePaymentMethod);
router.post(
  '/payment-methods/initialize-edit',
  ...mutatingGuard,
  validateBody(initializePaymentMethodEditSchema),
  controller.initializePaymentMethodEdit,
);
router.post('/payment-methods/register', ...mutatingGuard, validateBody(registerPaymentMethodSchema), controller.registerPaymentMethod);
router.get('/payment-methods', ...guard, validateQuery(listPaymentMethodsQuerySchema), controller.getPaymentMethods);
router.put(
  '/payment-methods/:methodId',
  ...mutatingGuard,
  validateParams(payloadPaymentMethodLocalIdParamSchema),
  validateBody(updateOwnerPaymentMethodSchema),
  controller.updateOwnerPaymentMethod,
);
router.delete(
  '/payment-methods/:methodId',
  ...mutatingGuard,
  validateParams(payloadPaymentMethodLocalIdParamSchema),
  validateBody(deleteOwnerPaymentMethodSchema),
  controller.deleteOwnerPaymentMethod,
);

/** HOA owner autopay (Payload mirror invoices + default payment method) */
router.get('/autopay', ...guard, validateQuery(ownerAutopayHoaQuerySchema), controller.getPayloadOwnerAutopay);
router.post('/autopay/enable', ...mutatingGuard, validateBody(enableOwnerAutopaySchema), controller.enablePayloadOwnerAutopay);
router.post('/autopay/disable', ...mutatingGuard, validateBody(disableOwnerAutopaySchema), controller.disablePayloadOwnerAutopay);
router.put(
  '/autopay/payment-method',
  ...mutatingGuard,
  validateBody(changeOwnerAutopayPaymentMethodSchema),
  controller.changePayloadOwnerAutopayPaymentMethod,
);

/**
 * Phase 3 — Vendor invoice electronic-pay eligibility (read-only when pay flag off).
 */
router.get(
  '/vendor-invoices/:vendorInvoiceId/pay-eligibility',
  ...guard,
  validateParams(vendorInvoicePayEligibilityParamSchema),
  controller.getVendorInvoicePayEligibility,
);

/**
 * Phase 4 — Owner → Vendor electronic pay (requires PAYLOAD_VENDOR_PAY_ENABLED).
 */
router.post(
  '/vendor-invoices/:vendorInvoiceId/payins/validate',
  ...mutatingGuard,
  validateParams(vendorInvoicePayEligibilityParamSchema),
  validateBody(validateVendorInvoicePayinBodySchema),
  controller.validateVendorInvoicePayin,
);
router.post(
  '/vendor-invoices/:vendorInvoiceId/payins/execute',
  ...mutatingGuard,
  validateParams(vendorInvoicePayEligibilityParamSchema),
  validateBody(executeVendorInvoicePayinBodySchema),
  controller.executeVendorInvoicePayin,
);
router.get(
  '/vendor-payins/:vendorPayinId',
  ...guard,
  validateParams(vendorPayinIdParamSchema),
  controller.getVendorPayin,
);

/** HOA owner invoice payins (Phase 3A–3C) */
router.post('/payins/validate', ...mutatingGuard, validateBody(validatePayloadPayinAllocationsSchema), controller.validatePayloadPayinAllocations);
router.post('/payins/execute', ...mutatingGuard, validateBody(executePayloadPayinSchema), controller.executePayloadPayin);
router.get('/payins/:payinId', ...guard, validateParams(payloadPayinIdParamSchema), controller.getPayloadPayin);

/** Production Check21 — board Record Payment Upload Check */
router.post(
  '/check21/submit-for-invoice',
  ...mutatingGuard,
  rateLimitCheck21Submit,
  runCheck21Upload,
  controller.submitPayloadCheck21ForInvoice,
);

/** HOA board Payload refunds / voids (Phase 3D) */
router.post('/refunds/request', ...mutatingGuard, validateBody(requestPayloadRefundSchema), controller.requestPayloadRefund);
router.get('/refunds/:refundId', ...guard, validateParams(payloadRefundIdParamSchema), controller.getPayloadRefund);

/** Production ops (Phase 3F) */
router.get('/operations/reconciliation', ...guard, validateQuery(reconciliationQuerySchema), controller.runPayloadReconciliation);
router.post('/operations/retry-webhooks', ...mutatingGuard, requireAdministrator, controller.retryPayloadWebhooks);

module.exports = router;
