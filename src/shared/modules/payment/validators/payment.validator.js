/**
 * ------------------------------------------------------------------
 * File: payment.validator.js
 * Module: Payment Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * payments.route
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const addressSchema = Joi.object({
  line1: Joi.string().optional(),
  city:  Joi.string().optional(),
  state: Joi.string().length(2).uppercase().optional(),
  zip:   Joi.string().pattern(/^\d{5}(-\d{4})?$/).optional()
});

const ssnSchema = Joi.string()
  .pattern(/^\d{3}-?\d{2}-?\d{4}$/, 'SSN format')
  .optional()
  .messages({ 'string.pattern.name': 'SSN must be in format XXX-XX-XXXX or 9 digits' });

const dobSchema = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/, 'date format')
  .messages({ 'string.pattern.name': 'Date of birth must be in YYYY-MM-DD format' });

// ── Customer schemas ──────────────────────────────────────────────────────────

const createCustomerSchema = Joi.object({
  name:      Joi.string().trim().min(2).max(100).required(),
  email:     Joi.string().email().required(),
  phone:     Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).required()
               .messages({ 'string.pattern.base': 'Phone number format is invalid' }),
  type:      Joi.string().valid('individual', 'business').default('individual'),
  ipAddress: Joi.string().ip({ version: ['ipv4', 'ipv6'], cidr: 'forbidden' }).optional(),

  // SaaS scope - HOA / landlord embedded account
  hoaId:             Joi.string().optional(),
  entityId:          Joi.string().optional(),
  entityType:        Joi.string().valid('landlord', 'hoa', 'property_manager').optional(),
  straddleAccountId: Joi.string().optional(),

  // Compliance - required for both individual and business (Straddle KYC)
  dob:     dobSchema.required(),
  ssn:     Joi.string()
               .pattern(/^\d{3}-?\d{2}-?\d{4}$/, 'SSN format')
               .required()
               .messages({ 'string.pattern.name': 'SSN must be in format XXX-XX-XXXX or 9 digits' }),
  address: addressSchema.optional(),

  // Business-only fields
  ein:               Joi.string().pattern(/^\d{2}-?\d{7}$/).optional()
                       .messages({ 'string.pattern.base': 'EIN must be in format XX-XXXXXXX or 9 digits' }),
  legalBusinessName: Joi.string().trim().max(200).optional(),
  website:           Joi.string().uri({ scheme: ['http', 'https'] }).optional()
                       .messages({ 'string.uri': 'Website must be a valid URL starting with http:// or https://' }),

  metadata: Joi.object().pattern(Joi.string(), Joi.string()).optional()
});

const updateCustomerSchema = Joi.object({
  name:      Joi.string().trim().min(2).max(100).optional(),
  email:     Joi.string().email().optional(),
  phone:     Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).optional()
               .messages({ 'string.pattern.base': 'Phone number format is invalid' }),

  // When either is sent, both should be present (enforced in service)
  dob:     dobSchema.optional(),
  ssn:     Joi.string()
               .pattern(/^\d{3}-?\d{2}-?\d{4}$/, 'SSN format')
               .optional()
               .messages({ 'string.pattern.name': 'SSN must be in format XXX-XX-XXXX or 9 digits' }),
  address: addressSchema.optional(),

  ein:               Joi.string().pattern(/^\d{2}-?\d{7}$/).optional()
                       .messages({ 'string.pattern.base': 'EIN must be in format XX-XXXXXXX or 9 digits' }),
  legalBusinessName: Joi.string().trim().max(200).optional(),
  website:           Joi.string().uri({ scheme: ['http', 'https'] }).optional()
                       .messages({ 'string.uri': 'Website must be a valid URL starting with http:// or https://' }),

  metadata: Joi.object().pattern(Joi.string(), Joi.string()).optional()
}).min(1)
  .and('dob', 'ssn'); // if one of dob/ssn is present, both are required

const linkBankAccountSchema = Joi.object({
  paymentCustomerId: Joi.string().required(),
  holderName:        Joi.string().required(),
  accountNumber:     Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  routingNumber:     Joi.alternatives().try(
                       Joi.string().pattern(/^\d{9}$/),
                       Joi.number().integer().min(100000000).max(999999999)
                     ).required(),
  accountType:       Joi.string().valid('checking', 'savings').default('checking')
});

const updateBankAccountSchema = Joi.object({
  holderName:  Joi.string().optional(),
  accountType: Joi.string().valid('checking', 'savings').optional()
}).min(1);

const createChargeSchema = Joi.object({
  amount:      Joi.number().integer().positive().required(), // cents e.g. $1.50 => 150
  paykeyId:    Joi.string().required(),
  description: Joi.string().optional(),
  paymentDate: Joi.string().isoDate().optional(),
  externalId:  Joi.string().optional(),
  metadata:    Joi.object().pattern(Joi.string(), Joi.string()).optional()
});

const createPayoutSchema = Joi.object({
  amount:      Joi.number().positive().required(),
  paykeyId:    Joi.string().required(),
  description: Joi.string().optional()
});

const idParamSchema = Joi.object({
  id: Joi.string().required()
});

const createBridgeSessionSchema = Joi.object({
  bankAccountId: Joi.string().optional(),
  /** Local PaymentCustomer id OR use with hoaId for owner Bridge flow */
  customerId:    Joi.string().optional(),
  hoaId:         Joi.string().optional(),
}).or('bankAccountId', 'customerId');

/** HOA Owner: start Add Bank - create lightweight customer + Bridge session */
const startOwnerBankLinkSchema = Joi.object({
  hoaId: Joi.string().required(),
});

/** Vendor: start Add Bank - no HOA required (platform/org Straddle scope) */
const startVendorBankLinkSchema = Joi.object({}).unknown(false);

/** HOA Owner: persist bank after Bridge widget success */
const completeOwnerBankLinkSchema = Joi.object({
  customerId:      Joi.string().required(),
  /** Straddle paykey / bridge bank id from widget callback */
  straddlePaykeyId: Joi.string().optional().allow('', null),
  paykey:           Joi.string().optional().allow('', null),
  status:           Joi.string().optional().allow('', null),
  holderName:       Joi.string().optional().allow('', null),
  accountType:      Joi.string().optional().allow('', null),
  routingNumber:    Joi.string().optional().allow('', null),
  last4:            Joi.string().optional().allow('', null),
  raw:              Joi.object().unknown(true).optional(),
});

const sendPaymentVerifyOtpSchema = Joi.object({
  phone: Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).required()
    .messages({ 'string.pattern.base': 'Phone number format is invalid' }),
  resend: Joi.boolean().optional().default(false),
});

const verifyPaymentVerifyOtpSchema = Joi.object({
  phone: Joi.string().pattern(/^[+]?[\d\s\-().]{7,20}$/).required()
    .messages({ 'string.pattern.base': 'Phone number format is invalid' }),
  otp: Joi.string().pattern(/^\d{4,6}$/).required()
    .messages({ 'string.pattern.base': 'Verification code must be 4-6 digits' }),
});

module.exports = {
  createCustomerSchema,
  updateCustomerSchema,
  linkBankAccountSchema,
  updateBankAccountSchema,
  createChargeSchema,
  createPayoutSchema,
  idParamSchema,
  createBridgeSessionSchema,
  startOwnerBankLinkSchema,
  startVendorBankLinkSchema,
  completeOwnerBankLinkSchema,
  sendPaymentVerifyOtpSchema,
  verifyPaymentVerifyOtpSchema,
};
