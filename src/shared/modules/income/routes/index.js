/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Income Module
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

// Import income routes
const incomeRoutes = require('./income.routes');

// Mount income routes
router.use('/', incomeRoutes);

module.exports = router;