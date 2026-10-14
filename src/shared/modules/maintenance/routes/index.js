/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Maintenance Module
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

// Load maintenance routes first to prevent conflicts
const maintenanceRoutes = require('./maintenance.routes');
const damageReportRoutes = require('./damageReport.routes');

// Mount maintenance routes first
router.use('/', maintenanceRoutes);

// Mount damage report routes second
router.use('/', damageReportRoutes);

module.exports = router;


