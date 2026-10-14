'use strict';

const Joi = require('joi');

const listHoasQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  period: Joi.string().valid('all', 'today', 'this_week', 'this_month').default('all'),
  status: Joi.string()
    .valid('all', 'active', 'in_progress', 'pending_setup', 'deleted')
    .default('all'),
  search: Joi.string().trim().max(100).allow('', null),
  sortBy: Joi.string().valid('createdAt', 'name').default('createdAt'),
  sortOrder: Joi.string().valid('asc', 'desc', 'ASC', 'DESC').default('desc'),
});

const sendEmailBodySchema = Joi.object({
  force: Joi.boolean().default(false),
  // Explicitly forbid client-supplied recipients to prevent SSRF / spam relays
  recipients: Joi.forbidden().messages({
    'any.unknown': 'Client-provided recipients are not permitted.',
  }),
  to: Joi.forbidden().messages({
    'any.unknown': 'Client-provided recipients are not permitted.',
  }),
  email: Joi.forbidden().messages({
    'any.unknown': 'Client-provided recipients are not permitted.',
  }),
}).unknown(false);

module.exports = {
  listHoasQuerySchema,
  sendEmailBodySchema,
};
