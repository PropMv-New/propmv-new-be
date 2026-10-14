'use strict';

const Joi = require('joi');
const { ENTITY_TYPE } = require('../constants/account.constants');

const addressSchema = Joi.object({
  line1:   Joi.string().trim().required(),
  line2:   Joi.string().trim().optional().allow('', null),
  city:    Joi.string().trim().required(),
  state:   Joi.string().length(2).uppercase().required(),
  zip:     Joi.string().pattern(/^\d{5}(-\d{4})?$/).required(),
  country: Joi.string().length(2).uppercase().default('US'),
});

const industrySchema = Joi.object({
  mcc:      Joi.string().trim().optional(),
  sector:   Joi.string().trim().optional(),
  category: Joi.string().trim().optional(),
});

const createAccountSchema = Joi.object({
  entityType:  Joi.string().valid(...Object.values(ENTITY_TYPE)).required(),
  // Optional - server derives from companyId / user when omitted
  entityId:    Joi.string().optional(),
  // Optional - never trust client; server overwrites from req.user.companyId
  businessId:  Joi.string().optional(),

  accountName: Joi.string().trim().min(2).max(200).required(),
  legalName:   Joi.string().trim().min(2).max(200).required(),
  accountType: Joi.string().valid('business').default('business'),
  email:       Joi.string().email().required(),
  phone:       Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).required()
                 .messages({ 'string.pattern.base': 'Phone number format is invalid' }),
  website:     Joi.string().uri({ scheme: ['http', 'https'] }).required()
                 .messages({ 'string.uri': 'Website must be a valid URL starting with http:// or https://' }),
  taxId:       Joi.string().pattern(/^\d{2}-?\d{7}$/).required()
                 .messages({ 'string.pattern.base': 'EIN / Tax ID must be 9 digits (XX-XXXXXXX)' }),
  description: Joi.string().trim().max(500).optional().allow('', null),
  useCase:     Joi.string().trim().max(500).optional().allow('', null),
  address:     addressSchema.required(),
  industry:    industrySchema.optional(),
  supportEmail: Joi.string().email().optional(),
  supportPhone: Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).optional(),
  supportUrl:   Joi.string().uri({ scheme: ['http', 'https'] }).optional(),
  metadata:     Joi.object().optional(),
});

const updateAccountSchema = Joi.object({
  accountName: Joi.string().trim().min(2).max(200).optional(),
  legalName:   Joi.string().trim().min(2).max(200).optional(),
  email:       Joi.string().email().optional(),
  phone:       Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).optional(),
  website:     Joi.string().uri({ scheme: ['http', 'https'] }).optional(),
  description: Joi.string().trim().max(500).optional().allow('', null),
  useCase:     Joi.string().trim().max(500).optional().allow('', null),
  address:     addressSchema.optional(),
  metadata:    Joi.object().optional(),
}).min(1);

const idParamSchema = Joi.object({
  id: Joi.string().required(),
});

const bankIdParamSchema = Joi.object({
  id:     Joi.string().required(),
  bankId: Joi.string().required(),
});

const addBankSchema = Joi.object({
  holderName:    Joi.string().trim().min(2).max(200).required(),
  accountNumber: Joi.alternatives().try(
    Joi.string().pattern(/^\d{4,17}$/),
    Joi.number().integer()
  ).required(),
  routingNumber: Joi.alternatives().try(
    Joi.string().pattern(/^\d{9}$/),
    Joi.number().integer().min(100000000).max(999999999)
  ).required(),
  accountType:   Joi.string().valid('checking', 'savings').default('checking'),
  isPrimary:     Joi.boolean().optional(),
  purposes:      Joi.array().items(Joi.string().valid('charges', 'payouts', 'billing')).max(3).optional(),
  description:   Joi.string().trim().max(200).optional().allow('', null),
  metadata:      Joi.object().pattern(Joi.string(), Joi.string().allow(null)).optional(),
});

/** Same fields as create - Straddle update requires full bank_account object */
const updateBankSchema = Joi.object({
  holderName:    Joi.string().trim().min(2).max(200).required(),
  accountNumber: Joi.alternatives().try(
    Joi.string().pattern(/^\d{4,17}$/),
    Joi.number().integer()
  ).required(),
  routingNumber: Joi.alternatives().try(
    Joi.string().pattern(/^\d{9}$/),
    Joi.number().integer().min(100000000).max(999999999)
  ).required(),
  accountType:   Joi.string().valid('checking', 'savings').optional(),
  metadata:      Joi.object().pattern(Joi.string(), Joi.string().allow(null)).optional(),
});

const relationshipSchema = Joi.object({
  primary:          Joi.boolean().optional(),
  control:          Joi.boolean().optional(),
  owner:            Joi.boolean().optional(),
  percentOwnership: Joi.number().min(0).max(100).optional(),
  title:            Joi.string().trim().max(120).optional().allow('', null),
});

const createRepresentativeSchema = Joi.object({
  firstName:    Joi.string().trim().min(1).max(100).required(),
  lastName:     Joi.string().trim().min(1).max(100).required(),
  dob:          Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
                  .messages({ 'string.pattern.base': 'Date of birth must be YYYY-MM-DD' }),
  ssnLast4:     Joi.string().pattern(/^\d{4}$/).optional(),
  email:        Joi.string().email().required(),
  mobileNumber: Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).required(),
  relationship: relationshipSchema.default({ control: true, primary: true }),
});

const updateRepresentativeSchema = Joi.object({
  firstName:    Joi.string().trim().min(1).max(100).optional(),
  lastName:     Joi.string().trim().min(1).max(100).optional(),
  dob:          Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ssnLast4:     Joi.string().pattern(/^\d{4}$/).optional(),
  email:        Joi.string().email().optional(),
  mobileNumber: Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).optional(),
  relationship: relationshipSchema.optional(),
}).min(1);

const repIdParamSchema = Joi.object({
  id:    Joi.string().required(),
  repId: Joi.string().required(),
});

const onboardingStepSchema = Joi.object({
  step: Joi.number().integer().min(1).max(5).required(),
});

const submitOnboardingSchema = Joi.object({
  agreementAccepted: Joi.boolean().valid(true).required(),
  agreementUrl:      Joi.string().uri({ scheme: ['http', 'https'] }).optional().allow('', null),
});

module.exports = {
  createAccountSchema,
  updateAccountSchema,
  idParamSchema,
  bankIdParamSchema,
  addBankSchema,
  updateBankSchema,
  createRepresentativeSchema,
  updateRepresentativeSchema,
  repIdParamSchema,
  onboardingStepSchema,
  submitOnboardingSchema,
};
