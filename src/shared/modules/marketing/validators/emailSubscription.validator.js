const Joi = require('joi');

const emailSubscriptionSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  source: Joi.string().trim().max(50).default('coming-soon'),
});

const listEmailSubscriptionsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  source: Joi.string().trim().max(50).allow('', null),
  search: Joi.string().trim().max(200).allow('', null),
  launchStatus: Joi.string().valid('all', 'pending', 'notified').default('all'),
});

const announceLaunchSchema = Joi.object({
  source: Joi.string().trim().max(50).default('coming-soon'),
  includeAlreadyNotified: Joi.boolean().default(false),
  dryRun: Joi.boolean().default(false),
});

module.exports = {
  emailSubscriptionSchema,
  listEmailSubscriptionsQuerySchema,
  announceLaunchSchema,
};
