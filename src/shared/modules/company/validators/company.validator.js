/**
 * ------------------------------------------------------------------
 * File: company.validator.js
 * Module: Company Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * company.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const createCompanySchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  description: Joi.string().trim().max(500).allow('', null),
  ownerId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  roles: Joi.array().items(
    Joi.object({
      name: Joi.string().trim().required(),
      description: Joi.string().trim().allow('', null),
      privileges: Joi.array().items(Joi.string()),
    })
  ),
  address: Joi.object({
    street: Joi.string().trim().allow('', null),
    city: Joi.string().trim().allow('', null),
    state: Joi.string().trim().allow('', null),
    zipCode: Joi.string().trim().allow('', null),
    country: Joi.string().trim().allow('', null),
  }),
  contactInfo: Joi.object({
    email: Joi.string().email().allow('', null),
    phone: Joi.string().trim().allow('', null),
    website: Joi.string().uri().allow('', null),
  }),
  settings: Joi.object({
    timezone: Joi.string().trim(),
    currency: Joi.string().trim(),
    dateFormat: Joi.string().trim(),
  }),
});

const updateCompanySchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  description: Joi.string().trim().max(500).allow('', null),
  isActive: Joi.boolean(),
  address: Joi.object({
    street: Joi.string().trim().allow('', null),
    city: Joi.string().trim().allow('', null),
    state: Joi.string().trim().allow('', null),
    zipCode: Joi.string().trim().allow('', null),
    country: Joi.string().trim().allow('', null),
  }),
  contactInfo: Joi.object({
    email: Joi.string().email().allow('', null),
    phone: Joi.string().trim().allow('', null),
    website: Joi.string().uri().allow('', null),
  }),
  settings: Joi.object({
    timezone: Joi.string().trim(),
    currency: Joi.string().trim(),
    dateFormat: Joi.string().trim(),
  }),
});

const addRoleSchema = Joi.object({
  name: Joi.string().trim().required(),
  description: Joi.string().trim().allow('', null),
  privileges: Joi.array().items(Joi.string()).required(),
});

const updateRoleSchema = Joi.object({
  name: Joi.string().trim(),
  description: Joi.string().trim().allow('', null),
  privileges: Joi.array().items(Joi.string()),
  isActive: Joi.boolean(),
});

const idParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

const roleIdParamSchema = Joi.object({
  id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  roleId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

module.exports = {
  createCompanySchema,
  updateCompanySchema,
  addRoleSchema,
  updateRoleSchema,
  idParamSchema,
  roleIdParamSchema,
};
