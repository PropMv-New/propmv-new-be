const Joi = require('joi');

const recordSiteVisitSchema = Joi.object({
  visitorId: Joi.string().trim().min(8).max(64).required(),
  sessionId: Joi.string().trim().min(8).max(64).required(),
  path: Joi.string().trim().max(500).required(),
  title: Joi.string().trim().max(300).allow('', null),
  referrer: Joi.string().trim().max(2000).allow('', null),
  query: Joi.string().trim().max(2000).allow('', null),
  language: Joi.string().trim().max(32).allow('', null),
  screenWidth: Joi.number().integer().min(0).max(10000).allow(null),
  screenHeight: Joi.number().integer().min(0).max(10000).allow(null),
  utmSource: Joi.string().trim().max(200).allow('', null),
  utmMedium: Joi.string().trim().max(200).allow('', null),
  utmCampaign: Joi.string().trim().max(200).allow('', null),
});

const listSiteVisitsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  path: Joi.string().trim().max(500).allow('', null),
  country: Joi.string().trim().max(100).allow('', null),
  deviceType: Joi.string().trim().valid('desktop', 'mobile', 'tablet').allow('', null),
  from: Joi.date().iso().allow('', null),
  to: Joi.date().iso().allow('', null),
});

module.exports = {
  recordSiteVisitSchema,
  listSiteVisitsQuerySchema,
};
