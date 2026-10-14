'use strict';

const Joi = require('joi');

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

const entityType = Joi.string().valid('landlord', 'hoa', 'property_manager');

const initializeMerchantSchema = Joi.object({
  entityType: entityType.required(),
  /** HOA community id or landlord company/user scope id */
  entityId: objectId.required(),
  businessId: objectId.optional(),
  accountName: Joi.string().trim().min(2).max(200).required(),
  merchantName: Joi.string().trim().max(200).optional(),
});

const listMerchantsQuerySchema = Joi.object({
  entityType: entityType.required(),
  entityId: objectId.optional(),
  hoaId: objectId.optional(),
  businessId: objectId.optional(),
});

const merchantStatusQuerySchema = Joi.object({
  accountId: objectId.required(),
  businessId: objectId.optional(),
});

const merchantSessionSchema = Joi.object({
  accountId: objectId.required(),
  businessId: objectId.optional(),
});

const initializePaymentMethodSchema = Joi.object({
  entityType: entityType.optional(),
  entityId: objectId.optional(),
  businessId: objectId.optional(),
  billableMerchantId: Joi.string().trim().max(120).optional(),
  allowedMethods: Joi.string().trim().max(120).optional(),
});

const registerPaymentMethodSchema = Joi.object({
  paymentMethodId: Joi.string().trim().max(120).required(),
  paymentMethodConfigId: Joi.string().trim().max(120).optional(),
  billableMerchantId: Joi.string().trim().max(120).optional(),
});

const rainforestAccountIdParamSchema = Joi.object({
  accountId: objectId.required(),
});

const rainforestDepositMethodIdParamSchema = Joi.object({
  accountId: objectId.required(),
  depositMethodId: objectId.required(),
});

const initializeDepositMethodSchema = Joi.object({
  holderName: Joi.string().trim().min(2).max(100).optional(),
  businessId: objectId.optional(),
});

const registerDepositMethodSchema = Joi.object({
  depositMethodId: Joi.string().trim().max(120).required(),
  depositMethodConfigId: Joi.string().trim().max(120).optional(),
  setAsPrimary: Joi.boolean().optional(),
  businessId: objectId.optional(),
});

const executeRainforestPayinSchema = Joi.object({
  invoiceId: objectId.required(),
  invoicePaymentAmount: Joi.number().positive().precision(2).required(),
  chargeAmount: Joi.number().positive().precision(2).optional(),
  paymentMethodId: Joi.string().trim().max(120).required(),
  paymentAttemptId: Joi.string().trim().max(120).required(),
  description: Joi.string().trim().max(500).optional(),
});

const validateRainforestPayinAllocationsSchema = Joi.object({
  paymentMethodId: Joi.string().trim().max(120).required(),
  allocations: Joi.array().items(Joi.object({
    invoiceId: objectId.required(),
    invoicePaymentAmount: Joi.number().positive().precision(2).optional(),
  })).min(1).max(50).required(),
});

const rainforestPayinIdParamSchema = Joi.object({
  payinId: Joi.alternatives().try(objectId, Joi.string().trim().max(120)).required(),
});

const requestRainforestRefundSchema = Joi.object({
  invoiceId: objectId.required(),
  paymentTransactionId: objectId.required(),
  amount: Joi.number().positive().precision(2).optional(),
  reason: Joi.string().valid('REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT').optional(),
  refundAttemptId: Joi.string().trim().max(120).required(),
});

const rainforestRefundIdParamSchema = Joi.object({
  refundId: Joi.alternatives().try(objectId, Joi.string().trim().max(120)).required(),
});

const reconciliationQuerySchema = Joi.object({
  hoaId: objectId.required(),
  since: Joi.date().iso().optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
  includeFailedWebhooks: Joi.boolean().optional(),
});

module.exports = {
  initializeMerchantSchema,
  listMerchantsQuerySchema,
  merchantStatusQuerySchema,
  merchantSessionSchema,
  rainforestAccountIdParamSchema,
  rainforestDepositMethodIdParamSchema,
  initializeDepositMethodSchema,
  registerDepositMethodSchema,
  initializePaymentMethodSchema,
  registerPaymentMethodSchema,
  executeRainforestPayinSchema,
  validateRainforestPayinAllocationsSchema,
  rainforestPayinIdParamSchema,
  requestRainforestRefundSchema,
  rainforestRefundIdParamSchema,
  reconciliationQuerySchema,
};
