/**
 * ------------------------------------------------------------------
 * File: dashboard.routes.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * routes
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const controller = require('../controller/dashboard.controller');
const { validateQuery } = require('../../../../../common/middleware/requestValidator');
const { summaryQuerySchema, recentActivityQuerySchema } = require('../validators/dashboard.validator');

// GET /api/v1/dashboard/summary
router.get('/summary', authMiddleware, authorize, lockCheckMiddleware, validateQuery(summaryQuerySchema), controller.getSummary);

// GET /api/v1/dashboard/recent-activity
router.get('/recent-activity', authMiddleware, authorize, lockCheckMiddleware, validateQuery(recentActivityQuerySchema), controller.getRecentActivity);

module.exports = router;

