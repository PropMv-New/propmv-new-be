/**
 * ------------------------------------------------------------------
 * File: paymentManagement.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * paymentManagement.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { createValidator } = require('../../../../../common/helpers/joiHelper');

const getPaymentManagementSchema = Joi.object({
  pageNumber: Joi.number().integer().min(1).optional(),
  pagesize: Joi.number().integer().min(1).max(100).optional(),
  search: Joi.string().trim().optional(),
  createdBy: Joi.string().trim().optional(),
});

const getPaymentSummarySchema = Joi.object({
  createdBy: Joi.string().trim().optional(),
});

const assignLandlordSchema = Joi.object({
  landlordName: Joi.string().trim().required(),
  landlordEmail: Joi.string().email().trim().optional(),
  landlordPhone: Joi.string().trim().optional(),
});

const upsertPaymentSettingsSchema = Joi.object({
  propertyId: Joi.string().trim().required(),
  percentageCut: Joi.number().min(0).max(100).required(),
});

module.exports = {
  validateGetPaymentManagement: createValidator(getPaymentManagementSchema, 'query'),
  validateGetPaymentSummary: createValidator(getPaymentSummarySchema, 'query'),
  validateAssignLandlord: createValidator(assignLandlordSchema, 'body'),
  validateUpsertPaymentSettings: createValidator(upsertPaymentSettingsSchema, 'body'),
};
