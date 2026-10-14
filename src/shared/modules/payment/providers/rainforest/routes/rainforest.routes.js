'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../../../../../../middleware/auth');
const csrfProtection = require('../../../../../../middleware/csrfProtection');
const authorize = require('../../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../../middleware/lockCheck');
const { validateBody, validateQuery, validateParams } = require('../../../../../../middleware/requestValidator');
const requireAdministrator = require('../../../../../../middleware/requireAdministrator');
const controller = require('../controller/rainforest.controller');
const {
  initializeMerchantSchema,
  listMerchantsQuerySchema,
  merchantStatusQuerySchema,
  merchantSessionSchema,
  rainforestAccountIdParamSchema,
  rainforestDepositMethodIdParamSchema,
  initializeDepositMethodSchema,
  registerDepositMethodSchema,
  initializePaymentMethodSchema,
  registerPaymentMethodSchema,
  executeRainforestPayinSchema,
  validateRainforestPayinAllocationsSchema,
  rainforestPayinIdParamSchema,
  requestRainforestRefundSchema,
  rainforestRefundIdParamSchema,
  reconciliationQuerySchema,
} = require('../validators/rainforest.validator');

const guard = [authMiddleware, authorize, lockCheckMiddleware];
const mutatingGuard = [csrfProtection, ...guard];

/** Public Rainforest feature flag / non-secret config */
router.get('/config', controller.getPublicConfig);

/** Merchant onboarding (landlord / HOA entities) */
router.get('/merchants', ...guard, validateQuery(listMerchantsQuerySchema), controller.listMerchants);
router.post('/merchants/initialize', ...mutatingGuard, validateBody(initializeMerchantSchema), controller.initializeMerchant);
router.get('/merchants/status', ...guard, validateQuery(merchantStatusQuerySchema), controller.getMerchantStatus);
router.post('/merchants/onboarding-session', ...mutatingGuard, validateBody(merchantSessionSchema), controller.createMerchantSession);
router.post('/merchants/:accountId/simulate-approval', ...mutatingGuard, validateParams(rainforestAccountIdParamSchema), controller.simulateRainforestMerchantApproval);

/** Merchant detail + deposit bank accounts (Phase 2A–2C) */
router.get('/merchants/:accountId', ...guard, validateParams(rainforestAccountIdParamSchema), controller.getRainforestMerchantDetail);
router.get('/merchants/:accountId/deposit-methods', ...guard, validateParams(rainforestAccountIdParamSchema), controller.listRainforestDepositMethods);
router.post('/merchants/:accountId/deposit-methods/sync', ...mutatingGuard, validateParams(rainforestAccountIdParamSchema), controller.syncRainforestDepositMethods);
router.post('/merchants/:accountId/deposit-methods/initialize', ...mutatingGuard, validateParams(rainforestAccountIdParamSchema), validateBody(initializeDepositMethodSchema), controller.initializeRainforestDepositMethod);
router.post('/merchants/:accountId/deposit-methods/register', ...mutatingGuard, validateParams(rainforestAccountIdParamSchema), validateBody(registerDepositMethodSchema), controller.registerRainforestDepositMethod);
router.post('/merchants/:accountId/deposit-methods/:depositMethodId/set-primary', ...mutatingGuard, validateParams(rainforestDepositMethodIdParamSchema), controller.setPrimaryRainforestDepositMethod);

/** Payor saved payment methods (tenant / HOA owner) */
router.post('/payment-methods/initialize', ...mutatingGuard, validateBody(initializePaymentMethodSchema), controller.initializePaymentMethod);
router.post('/payment-methods/register', ...mutatingGuard, validateBody(registerPaymentMethodSchema), controller.registerPaymentMethod);
router.get('/payment-methods', ...guard, controller.getPaymentMethods);

/** HOA owner invoice payins (Phase 3A–3C) */
router.post('/payins/validate', ...mutatingGuard, validateBody(validateRainforestPayinAllocationsSchema), controller.validateRainforestPayinAllocations);
router.post('/payins/execute', ...mutatingGuard, validateBody(executeRainforestPayinSchema), controller.executeRainforestPayin);
router.get('/payins/:payinId', ...guard, validateParams(rainforestPayinIdParamSchema), controller.getRainforestPayin);

/** HOA board Rainforest refunds / voids (Phase 3D) */
router.post('/refunds/request', ...mutatingGuard, validateBody(requestRainforestRefundSchema), controller.requestRainforestRefund);
router.get('/refunds/:refundId', ...guard, validateParams(rainforestRefundIdParamSchema), controller.getRainforestRefund);

/** Production ops (Phase 3F) */
router.get('/operations/reconciliation', ...guard, validateQuery(reconciliationQuerySchema), controller.runRainforestReconciliation);
router.post('/operations/retry-webhooks', ...mutatingGuard, requireAdministrator, controller.retryRainforestWebhooks);

module.exports = router;
