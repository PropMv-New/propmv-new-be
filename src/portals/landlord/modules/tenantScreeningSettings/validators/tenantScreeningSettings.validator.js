/**
 * ------------------------------------------------------------------
 * File: tenantScreeningSettings.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * tenantScreeningSettings.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

/**
 * Validator for screening option objects
 */
const screeningOptionSchema = Joi.object({
  optionId: Joi.string()
    .valid('application_only', 'application_credit', 'application_credit_criminal_eviction')
    .required(),
  label: Joi.string().required(),
  innagoFee: Joi.number().min(0).required(),
  additionalFee: Joi.number().min(0).required(),
  totalFee: Joi.number().min(0).required(),
});

/**
 * Validator for creating tenant screening settings
 * Requires all screening options to be provided in request body
 */
const createScreeningSettingsSchema = Joi.object({
  selectedOption: Joi.string()
    .valid('application_only', 'application_credit', 'application_credit_criminal_eviction')
    .optional()
    .default('application_only'),
  // Required: provide all screening options with complete fee information
  screeningOptions: Joi.array().items(screeningOptionSchema).required().min(1),
  includeIncomeVerification: Joi.boolean().optional(),
  useMultipleTemplates: Joi.boolean().optional(),
  includeCriminalHistory: Joi.boolean().optional(),
  property_id: Joi.string().pattern(objectIdRegex).optional().allow(null),
  expiresAt: Joi.date().optional().allow(null),
});

/**
 * Validator for updating existing screening settings
 */
const updateScreeningSettingsSchema = Joi.object({
  selectedOption: Joi.string()
    .valid('application_only', 'application_credit', 'application_credit_criminal_eviction')
    .optional(),
  screeningOptions: Joi.array().items(screeningOptionSchema).optional(),
  includeIncomeVerification: Joi.boolean().optional(),
  useMultipleTemplates: Joi.boolean().optional(),
  includeCriminalHistory: Joi.boolean().optional(),
  property_id: Joi.string().pattern(objectIdRegex).optional().allow(null),
  expiresAt: Joi.date().optional().allow(null),
});

/**
 * Validator for ID parameter
 */
const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
});

/**
 * Validator for query parameters (list settings)
 */
const listQuerySchema = Joi.object({
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(200).optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
});

module.exports = {
  createScreeningSettingsSchema,
  updateScreeningSettingsSchema,
  idParamSchema,
  listQuerySchema,
};
