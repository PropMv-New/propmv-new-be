/**
 * ------------------------------------------------------------------
 * File: tenantScreeningSettings.routes.js
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
const tenantScreeningSettingsController = require('../controller/tenantScreeningSettings.controller');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const { validateBody, validateParams, validateQuery } = require('../../../../../middleware/requestValidator');
const {
  createScreeningSettingsSchema,
  updateScreeningSettingsSchema,
  idParamSchema,
  listQuerySchema,
} = require('../validators/tenantScreeningSettings.validator');

// /api/v1/landlord/tenant-screening-settings

// Create new screening settings (authenticated)
router.post(
  '/',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateBody(createScreeningSettingsSchema),
  tenantScreeningSettingsController.createScreeningSettings
);

// Get all screening settings by creator (authenticated)
router.get(
  '/',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateQuery(listQuerySchema),
  tenantScreeningSettingsController.getScreeningSettingsByCreator
);

// Get screening settings by ID (public - for URL sharing with expiration check)
router.get(
  '/:id',
  validateParams(idParamSchema),
  tenantScreeningSettingsController.getScreeningSettingsById
);

// Update screening settings (authenticated)
router.put(
  '/:id',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  validateBody(updateScreeningSettingsSchema),
  tenantScreeningSettingsController.updateScreeningSettings
);

// Delete screening settings (authenticated)
router.delete(
  '/:id',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  tenantScreeningSettingsController.deleteScreeningSettings
);

module.exports = router;
