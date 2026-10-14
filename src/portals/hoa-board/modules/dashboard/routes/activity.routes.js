/**
 * ------------------------------------------------------------------
 * File: activity.routes.js
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
const activityController = require('../controller/activity.controller');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const csrfProtection = require('../../../../../middleware/csrfProtection');

router.get('/recent', authMiddleware, authorize, lockCheckMiddleware, activityController.getRecentActivities);
router.post('/log', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, activityController.logClientActivity);

module.exports = router;
