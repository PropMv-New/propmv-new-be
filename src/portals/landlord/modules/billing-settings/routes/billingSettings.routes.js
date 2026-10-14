/**
 * ------------------------------------------------------------------
 * File: billingSettings.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../../../../../shared/modules/billing-settings/controller/billingSettings.controller');
const { upsertBillingSettingsSchema, effectiveQuerySchema } = require('../../../../../shared/modules/billing-settings/validators/billingSettings.validator');
const { validateQuery, validateBody } = require('../../../../../common/middleware/requestValidator');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const { captureAuditBefore } = require('../../../../../shared/modules/audit/middleware/auditBeforeCapture.middleware');
const { loadBillingSettingsBefore } = require('../../../../../shared/modules/audit/loaders/auditBeforeLoaders');

router.use(authMiddleware, authorize);

router.get('/effective', validateQuery(effectiveQuerySchema), controller.getEffectiveBillingSettings);
router.get('/', controller.getOperatorBillingSettings);
router.put('/', captureAuditBefore(loadBillingSettingsBefore), validateBody(upsertBillingSettingsSchema), controller.upsertOperatorBillingSettings);

module.exports = router;
