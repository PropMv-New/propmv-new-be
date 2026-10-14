/**
 * ------------------------------------------------------------------
 * File: event.validator.js
 * Module: Events Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * event.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const createEventSchema = Joi.object({
  event: Joi.string().required(),
  from: Joi.string().pattern(objectIdRegex).required(),
  to: Joi.string().pattern(objectIdRegex).required(),
  notificationDate: Joi.date().iso().required(),
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  unit: Joi.string().required()
});

const updateEventSchema = Joi.object({
  event: Joi.string().optional(),
  from: Joi.string().pattern(objectIdRegex).optional(),
  to: Joi.string().pattern(objectIdRegex).optional(),
  notificationDate: Joi.date().iso().optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional()
});

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).optional(),
  event: Joi.string().optional(),
  from: Joi.string().pattern(objectIdRegex).optional(),
  to: Joi.string().pattern(objectIdRegex).optional(),
  notificationDate: Joi.date().iso().optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional()
});

module.exports = {
  createEventSchema,
  updateEventSchema,
  idParamSchema,
  listQuerySchema
};
