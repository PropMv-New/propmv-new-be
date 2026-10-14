/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Src Portals
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
const authMiddleware = require('../middleware/auth');

// Apply authentication to all portal routes
router.use(authMiddleware);

// Import portal routers
const hoaBoardRouter = require('./hoa-board');
const landlordRouter = require('./landlord');

// Mount portal-specific routes
router.use('/hoa', hoaBoardRouter);
router.use('/landlord', landlordRouter);

module.exports = router;
