/**
 * ------------------------------------------------------------------
 * File: payee.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * expense.routes, payee.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const { personNameFieldJoi } = require('../../../../../shared/utils/personNameValidation.util');

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const createPayeeSchema = Joi.object({
  organization: Joi.string().max(200).optional().allow('', null),
  firstName: personNameFieldJoi('First name').messages({ 'any.required': 'firstName is required' }),
  lastName: personNameFieldJoi('Last name').messages({ 'any.required': 'lastName is required' }),
  email: Joi.string().email().max(200).optional().allow('', null),
  phone: Joi.string().max(50).optional().allow('', null),
  category: Joi.string().valid('Contractor', 'Insurance', 'Lender', 'Maintenance', 'Management Company', 'Owner', 'Professional', 'PropMv', 'Supplier', 'Tax', 'Uncategorized', 'Utility').required(),
  website: Joi.string().uri().max(200).optional().allow('', null),
  addressLine1: Joi.string().max(200).optional().allow('', null),
  addressLine2: Joi.string().max(200).optional().allow('', null),
  city: Joi.string().max(100).optional().allow('', null),
  state: Joi.string().max(50).optional().allow('', null),
  zipCode: Joi.string().max(20).optional().allow('', null),
  secondaryPhone: Joi.string().max(50).optional().allow('', null),
  // Set in payee.service from req.hoaContext (middleware skips body injection for /payees)
  createdBy: Joi.any().optional(),
  hoaId: Joi.any().optional(),
  hoaBoardMemberId: Joi.any().optional(),
});

const updatePayeeSchema = Joi.object({
  organization: Joi.string().max(200).optional().allow('', null),
  firstName: personNameFieldJoi('First name', { required: false }),
  lastName: personNameFieldJoi('Last name', { required: false }),
  email: Joi.string().email().max(200).optional().allow('', null),
  phone: Joi.string().max(50).optional().allow('', null),
  category: Joi.string().valid('Contractor', 'Insurance', 'Lender', 'Maintenance', 'Management Company', 'Owner', 'Professional', 'PropMv', 'Supplier', 'Tax', 'Uncategorized', 'Utility').optional(),
  website: Joi.string().uri().max(200).optional().allow('', null),
  addressLine1: Joi.string().max(200).optional().allow('', null),
  addressLine2: Joi.string().max(200).optional().allow('', null),
  city: Joi.string().max(100).optional().allow('', null),
  state: Joi.string().max(50).optional().allow('', null),
  zipCode: Joi.string().max(20).optional().allow('', null),
  secondaryPhone: Joi.string().max(50).optional().allow('', null)
}).min(1);

const listQuerySchema = Joi.object({
  category: Joi.string().valid('Contractor', 'Insurance', 'Lender', 'Maintenance', 'Management Company', 'Owner', 'Professional', 'PropMv', 'Supplier', 'Tax', 'Uncategorized', 'Utility').optional(),
  search: Joi.string().optional(),
  pageNumber: Joi.number().integer().min(1).default(1),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(500).default(10)
});

module.exports = {
  idParamSchema,
  createPayeeSchema,
  updatePayeeSchema,
  listQuerySchema
};
