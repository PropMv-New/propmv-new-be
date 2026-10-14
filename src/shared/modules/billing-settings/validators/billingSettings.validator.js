/**
 * ------------------------------------------------------------------
 * File: billingSettings.validator.js
 * Module: Billing Settings Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * billingSettings.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const paidBySchema = Joi.string().valid('payer', 'operator', 'charge_me', 'charge_tenant', 'charge_owner');

const upsertBillingSettingsSchema = Joi.object({
  transactionFees: Joi.object({
    bankTransfer: Joi.object({
      feeAmount: Joi.number().min(0).optional(),
      paidBy: paidBySchema.optional(),
    }).optional(),
    card: Joi.object({
      feePercent: Joi.number().min(0).max(100).optional(),
      paidBy: paidBySchema.optional(),
    }).optional(),
  }).optional(),
}).min(1);

const effectiveQuerySchema = Joi.object({
  propertyId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  context: Joi.string().valid('hoa-board').optional(),
});

module.exports = {
  upsertBillingSettingsSchema,
  effectiveQuerySchema,
};
