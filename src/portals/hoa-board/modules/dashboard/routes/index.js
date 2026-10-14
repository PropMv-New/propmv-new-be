/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const activityRoutes = require('./activity.routes');
const dashboardRoutes = require('./dashboard.routes');

router.use('/activity', activityRoutes);
router.use('/', dashboardRoutes);

module.exports = router;
