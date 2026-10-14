/**
 * ------------------------------------------------------------------
 * File: hoaSettings.routes.js
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
const hoaSettingsController = require('../controller/hoaSettings.controller');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const { validateBody, validateParams } = require('../../../../../common/middleware/requestValidator');
const {
  hoaIdParamSchema,
  upsertHoaSettingsSchema,
} = require('../validators/hoaSettings.validator');

// GET  /api/v1/hoa/hoa-settings        - auto-resolve active HOA from user context
// GET  /api/v1/hoa/hoa-settings/:hoaId - explicit HOA (multi-HOA switcher)
router.get('/', authMiddleware, authorize, hoaSettingsController.getSettings);
router.get(
  '/:hoaId/payment-policy',
  authMiddleware,
  authorize,
  validateParams(hoaIdParamSchema),
  hoaSettingsController.getPaymentPolicy,
);
router.get(
  '/:hoaId',
  authMiddleware,
  authorize,
  validateParams(hoaIdParamSchema),
  hoaSettingsController.getSettings
);

// PUT  /api/v1/hoa/hoa-settings        - auto-resolve active HOA from user context
// PUT  /api/v1/hoa/hoa-settings/:hoaId - explicit HOA (multi-HOA switcher)
router.put(
  '/',
  authMiddleware,
  csrfProtection,
  authorize,
  validateBody(upsertHoaSettingsSchema),
  hoaSettingsController.upsertSettings
);
router.put(
  '/:hoaId',
  authMiddleware,
  csrfProtection,
  authorize,
  validateParams(hoaIdParamSchema),
  validateBody(upsertHoaSettingsSchema),
  hoaSettingsController.upsertSettings
);

module.exports = router;
