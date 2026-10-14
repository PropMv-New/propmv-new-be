/**
 * ------------------------------------------------------------------
 * File: quoteEstimate.routes.js
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
const controller = require('../controller/quoteEstimate.controller');
const referLeadController = require('../controller/referLead.controller');
const { validateBody, validateQuery, validateParams } = require('../../../../../middleware/requestValidator');
const {
  createQuoteEstimateSchema,
  paginationQuerySchema,
  objectIdParamSchema,
} = require('../validators/quoteEstimate.validator');
const { referLeadSchema } = require('../validators/referLead.validator');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');

// POST /api/v1/landlord/insurance/quote-estimates
router.post(
  '/quote-estimates',
  authMiddleware,
  authorize,
  validateBody(createQuoteEstimateSchema),
  controller.createQuoteEstimate
);

// GET /api/v1/landlord/insurance/quote-estimates
router.get(
  '/quote-estimates',
  authMiddleware,
  authorize,
  validateQuery(paginationQuerySchema),
  controller.getQuoteEstimates
);

// GET /api/v1/landlord/insurance/quote-estimates/:id
router.get(
  '/quote-estimates/:id',
  authMiddleware,
  authorize,
  validateParams(objectIdParamSchema),
  controller.getQuoteEstimateById
);

// POST /api/v1/landlord/insurance/refer-lead
router.post(
  '/refer-lead',
  authMiddleware,
  authorize,
  validateBody(referLeadSchema),
  referLeadController.createReferLead
);

module.exports = router;
