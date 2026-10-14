/**
 * ------------------------------------------------------------------
 * File: billingSettings.routes.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../../../../../shared/modules/billing-settings/controller/billingSettings.controller');
const { upsertBillingSettingsSchema, effectiveQuerySchema } = require('../../../../../shared/modules/billing-settings/validators/billingSettings.validator');
const { validateQuery, validateBody } = require('../../../../../common/middleware/requestValidator');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const requireRole = require('../../../../../middleware/requireRole');
const { requireOwnerPropertyAccess } = require('../../../../../middleware/hoaOwnerPropertyAccess');
const { ROLE_NAMES } = require('../../../../../common/constants/roleNames');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const { captureAuditBefore } = require('../../../../../shared/modules/audit/middleware/auditBeforeCapture.middleware');
const { loadBillingSettingsBefore } = require('../../../../../shared/modules/audit/loaders/auditBeforeLoaders');

const boardMemberOnly = requireRole(ROLE_NAMES.HOA_BOARD_MEMBER);

// Owners need effective fee settings to pay invoices; board members manage full settings.
router.get(
  '/effective',
  authMiddleware,
  requireOwnerPropertyAccess,
  authorize,
  validateQuery(effectiveQuerySchema),
  controller.getEffectiveBillingSettings
);

router.get('/', authMiddleware, boardMemberOnly, authorize, controller.getHoaBillingSettings);
router.put('/', csrfProtection, authMiddleware, boardMemberOnly, authorize, captureAuditBefore(loadBillingSettingsBefore), validateBody(upsertBillingSettingsSchema), controller.upsertHoaBillingSettings);

module.exports = router;
