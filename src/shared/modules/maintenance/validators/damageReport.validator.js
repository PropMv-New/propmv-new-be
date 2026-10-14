/**
 * ------------------------------------------------------------------
 * File: damageReport.validator.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * damageReport.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const itemSchema = Joi.object({
  title: Joi.string().required().trim(),
  condition: Joi.string().required().trim(),
  description: Joi.string().trim().allow(''),
  fileCount: Joi.number().integer().min(0).default(0),
  attachments: Joi.array().items(Joi.object())
});

const createDamageReportSchema = Joi.object({
  location: Joi.string().required().trim(),
  unit: Joi.string().required().trim(),
  items: Joi.array().items(itemSchema).min(1).required(),
  property_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/)
});

const updateDamageReportSchema = Joi.object({
  location: Joi.string().trim(),
  unit: Joi.string().trim(),
  items: Joi.array().items(itemSchema).min(1),
  property_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/)
});

const listDamageReportsSchema = Joi.object({
  property_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  location: Joi.string().trim(),
  unit: Joi.string().trim(),
  createdBy: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  pageNumber: Joi.number().integer().min(1),
  page: Joi.number().integer().min(1),
  pageSize: Joi.number().integer().min(1)
}).custom((value, helpers) => {
  if (value.unit && !value.property_id) {
    return helpers.error('any.invalid', { message: 'property_id is required when filtering by unit' });
  }
  return value;
});

module.exports = {
  createDamageReportSchema,
  updateDamageReportSchema,
  listDamageReportsSchema
};


