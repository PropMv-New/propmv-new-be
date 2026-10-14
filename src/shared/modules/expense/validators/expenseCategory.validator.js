'use strict';

const Joi = require('joi');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const createExpenseCategorySchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(500).optional().allow('', null),
});

const updateExpenseCategorySchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).optional(),
  description: Joi.string().trim().max(500).optional().allow('', null),
  isActive: Joi.boolean().optional(),
}).min(1);

const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
});

module.exports = {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  idParamSchema,
};
