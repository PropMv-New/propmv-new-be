/**
 * ------------------------------------------------------------------
 * File: dashboard.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * dashboard.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const objectIdRegex = /^[0-9a-fA-F]{24}$/;

// Query schema for /summary endpoint
const summaryQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  startDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  endDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
});

module.exports = {
  summaryQuerySchema,
};
