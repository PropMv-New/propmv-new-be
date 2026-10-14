/**
 * ------------------------------------------------------------------
 * File: address.routes.js
 * Module: Src Shared Modules Address Routes
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();

const addressController = require('../controller/address.controller');
const { addressRateLimit, addressUsageRateLimit } = require('../middleware/rateLimit');
const authMiddleware = require('../../../../middleware/auth');

// Public endpoints (also used during signup, so no auth) - rate limited.
router.get('/provider', addressRateLimit, addressController.getProvider);
router.get('/autocomplete', addressRateLimit, addressController.autocomplete);
// Usage reports use a separate, larger budget: throttling them would undercount
// Google's quota and lead to billing, which is worse than the write itself.
router.post('/usage', addressUsageRateLimit, addressController.reportUsage);

// Authenticated monitoring endpoint.
router.get('/usage', authMiddleware, addressController.getUsageSummary);

module.exports = router;
