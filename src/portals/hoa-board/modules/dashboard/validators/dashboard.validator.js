/**
 * ------------------------------------------------------------------
 * File: dashboard.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * dashboard.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

/** Inclusive filter bounds as calendar YYYY-MM-DD (avoids Joi UTC-midnight day shift). */
const dateOnlyYmd = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({
  'string.pattern.base': 'must be a valid date in YYYY-MM-DD format',
});

// Query schema for /summary endpoint
const summaryQuerySchema = Joi.object({
  landlordId: Joi.string().required(),
  context: Joi.string().valid('hoa-board').optional(),
  communityId: Joi.string().optional(),
  hoaId: Joi.string().optional(),
  startDate: dateOnlyYmd.optional(),
  endDate: dateOnlyYmd.optional(),
  preset: Joi.string().valid('this_month', 'last_month', 'next_month', 'last_3_months', 'last_6_months', 'next_6_months', 'year_to_date', 'last_year').optional(),
});

// Query schema for /recent-activity endpoint
const recentActivityQuerySchema = Joi.object({
  landlordId: Joi.string().optional(),
  context: Joi.string().valid('hoa-board').optional(),
  communityId: Joi.string().optional(),
  hoaId: Joi.string().optional(),
  limit: Joi.number().integer().min(1).max(50).optional(),
  userRole: Joi.string().valid('landlord', 'hoa_board', 'tenant').optional(),
  startDate: dateOnlyYmd.optional(),
  endDate: dateOnlyYmd.optional(),
  days: Joi.number().integer().min(1).max(30).optional(),
});

module.exports = {
  summaryQuerySchema,
  recentActivityQuerySchema,
};
