/**
 * ------------------------------------------------------------------
 * File: import.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const importSchema = Joi.object({
  // CSV import doesn't require specific query parameters
  // File validation is handled by multer middleware
});

module.exports = {
  importSchema
};