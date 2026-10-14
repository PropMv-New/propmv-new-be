/**
 * ------------------------------------------------------------------
 * File: masterData.validator.js
 * Module: Src Shared Modules Master Validators
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * masterData.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const listQuerySchema = Joi.object({
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional()
});

module.exports = {
  listQuerySchema
};