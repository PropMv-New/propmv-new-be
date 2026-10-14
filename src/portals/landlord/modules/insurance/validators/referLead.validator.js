const Joi = require('joi');

// SubmitPolicyholder: first_name, last_name, email required; phone_number optional
const referLeadSchema = Joi.object({
  external_record_id: Joi.string().optional().allow(null, ''),

  primary_insured: Joi.object({
    first_name:   Joi.string().max(100).required().messages({
      'any.required': 'primary_insured.first_name is required',
      'string.empty': 'primary_insured.first_name cannot be empty',
    }),
    last_name:    Joi.string().max(100).required().messages({
      'any.required': 'primary_insured.last_name is required',
      'string.empty': 'primary_insured.last_name cannot be empty',
    }),
    email:        Joi.string().email().required().messages({
      'any.required': 'primary_insured.email is required',
      'string.email': 'primary_insured.email must be a valid email address',
    }),
    phone_number: Joi.string().max(32).optional().allow(null, ''),
  }).required().messages({
    'any.required': 'primary_insured is required',
  }),

  // Optional: property address to include with the referral
  properties: Joi.array().items(
    Joi.object({
      address: Joi.object({
        street_address: Joi.string().optional().allow(null, ''),
        city:           Joi.string().optional().allow(null, ''),
        state:          Joi.string().optional().allow(null, ''),
        zip_code:       Joi.string().optional().allow(null, ''),
      }).required(),
    })
  ).optional().allow(null),
});

module.exports = { referLeadSchema };
