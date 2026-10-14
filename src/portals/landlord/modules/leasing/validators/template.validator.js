/**
 * ------------------------------------------------------------------
 * File: template.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * template.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const createdByParamSchema = Joi.object({ createdBy: Joi.string().pattern(objectIdRegex).required() });
const templateIdParamSchema = Joi.object({ templateId: Joi.string().pattern(objectIdRegex).required() });
const updateParamsSchema = Joi.object({ createdBy: Joi.string().pattern(objectIdRegex).required(), templateId: Joi.string().pattern(objectIdRegex).required() });

const createTemplateSchema = Joi.object({
  templateName: Joi.string().trim().required(),
  description: Joi.string().trim().optional().allow('', null),
  templateType: Joi.string().trim().optional().allow('', null),
});

const updateTemplateSchema = Joi.object({
  templateName: Joi.string().trim().optional(),
  description: Joi.string().trim().optional().allow('', null),
  templateType: Joi.string().trim().optional().allow('', null),
});

// Schema for query parameters in get templates endpoint
const getTemplatesQuerySchema = Joi.object({
  templateName: Joi.string().trim().optional().allow('', null),
  templateType: Joi.string().trim().optional().allow('', null),
  pageNumber: Joi.number().integer().min(1).default(1),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
});

module.exports = {
  createdByParamSchema,
  templateIdParamSchema,
  updateParamsSchema,
  createTemplateSchema,
  updateTemplateSchema,
  getTemplatesQuerySchema
};
