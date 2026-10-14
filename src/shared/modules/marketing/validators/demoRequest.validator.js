const Joi = require('joi');

const demoRequestSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  email: Joi.string().trim().email().max(200).required(),
  phone: Joi.string().trim().max(40).allow('', null),
  role: Joi.string().trim().max(60).allow('', null),
  propertyCount: Joi.string().trim().max(40).allow('', null),
  preferredDate: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null)
    .messages({ 'string.pattern.base': 'preferredDate must be YYYY-MM-DD' }),
  preferredTime: Joi.string().trim().max(120).allow('', null),
  message: Joi.string().trim().max(2000).allow('', null),
  source: Joi.string().trim().max(60).default('website'),
  // Honeypot: a hidden field only a bot fills in. Allowed through validation so
  // the request looks accepted, then dropped in the controller.
  company: Joi.string().trim().max(200).allow('', null),
});

const listDemoRequestsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  status: Joi.string().valid('all', 'new', 'contacted', 'scheduled', 'closed').default('all'),
  search: Joi.string().trim().max(200).allow('', null),
});

module.exports = { demoRequestSchema, listDemoRequestsQuerySchema };
