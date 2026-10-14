const Joi = require('joi');

const paymentMethodIdParam = Joi.object({
  paymentMethodId: Joi.string().pattern(/^pm_/).required()
    .messages({ 'string.pattern.base': 'Invalid paymentMethodId format' }),
});

module.exports = { paymentMethodIdParam };
