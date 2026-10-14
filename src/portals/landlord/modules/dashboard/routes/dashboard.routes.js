/**
 * ------------------------------------------------------------------
 * File: dashboard.routes.js
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
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const controller = require('../controller/dashboard.controller');
const { validateQuery } = require('../../../../../middleware/requestValidator');
const { summaryQuerySchema } = require('../validators/dashboard.validator');

// GET /api/v1/dashboard/summary
router.get('/summary', authMiddleware, authorize, lockCheckMiddleware, validateQuery(summaryQuerySchema), controller.getSummary);

module.exports = router;
