/**
 * ------------------------------------------------------------------
 * File: master.validator.js
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

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const masterCreateSchema = Joi.object({
  type: Joi.string().min(1).required(),
  key: Joi.string().min(1).required(),
  data: Joi.array().required()
});

// update allows same fields but all optional (except we still expect data to be array when present)
const masterUpdateSchema = Joi.object({
  type: Joi.string().min(1).optional(),
  key: Joi.string().min(1).optional(),
  data: Joi.array().optional()
});

const keysQuerySchema = Joi.object({
  keys: Joi.alternatives().try(Joi.array().items(Joi.string().min(1)), Joi.string().min(1)).optional()
});

module.exports = {
  idParamSchema,
  masterCreateSchema,
  masterUpdateSchema,
  keysQuerySchema,
};
