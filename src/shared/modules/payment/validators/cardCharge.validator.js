const Joi = require('joi');

const chargeCardSchema = Joi.object({
  invoiceId:       Joi.string().required(),
  amount:          Joi.number().positive().required(),
  currency:        Joi.string().default('usd'),
  paymentMethodId: Joi.string().pattern(/^pm_/).required()
    .messages({ 'string.pattern.base': 'Invalid paymentMethodId format' }),
  description:     Joi.string().max(500).optional(),
});

module.exports = { chargeCardSchema };
