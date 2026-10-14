'use strict';

const Joi = require('joi');

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

/** Owner / HOA payer scopes — Vendor is not a payer wallet entity in Phase 1. */
const entityType = Joi.string().trim().lowercase().valid(
  'landlord',
  'hoa',
  'property_manager',
);

/** Merchant onboarding scopes — includes Vendor Processing Accounts (Phase 1). */
const merchantEntityType = Joi.string().trim().lowercase().valid(
  'landlord',
  'hoa',
  'property_manager',
  'vendor',
);

const initializeMerchantSchema = Joi.object({
  entityType: merchantEntityType.required(),
  /**
   * HOA community id, landlord company/user scope id, or Vendor user id
   * (for entityType=vendor the server ignores client entityId and uses auth user id).
   */
  entityId: objectId.required(),
  businessId: objectId.optional(),
  accountName: Joi.string().trim().min(2).max(200).required(),
  merchantName: Joi.string().trim().max(200).optional(),
});

const listMerchantsQuerySchema = Joi.object({
  entityType: merchantEntityType.required(),
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

const registerMerchantProcessingAccountSchema = Joi.object({
  processingAccountId: Joi.string().trim().min(4).max(120).required(),
  businessId: objectId.optional(),
});

const initializePaymentMethodSchema = Joi.object({
  entityType: entityType.optional(),
  entityId: objectId.optional(),
  businessId: objectId.optional(),
  billableMerchantId: Joi.string().trim().max(120).optional(),
  allowedMethods: Joi.string().trim().max(120).optional(),
});

const initializePaymentMethodEditSchema = Joi.object({
  localMethodId: objectId.required(),
  entityType: entityType.optional(),
  entityId: objectId.optional(),
  allowedMethods: Joi.string().trim().max(120).optional(),
});

const registerPaymentMethodSchema = Joi.object({
  paymentMethodId: Joi.string().trim().max(120).required(),
  paymentMethodConfigId: Joi.string().trim().max(120).optional(),
  billableMerchantId: Joi.string().trim().max(120).optional(),
  entityType: entityType.optional(),
  entityId: objectId.optional(),
});

const listPaymentMethodsQuerySchema = Joi.object({
  entityType: entityType.optional(),
  entityId: objectId.optional(),
});

const payloadPaymentMethodLocalIdParamSchema = Joi.object({
  methodId: objectId.required(),
});

const updateOwnerPaymentMethodSchema = Joi.object({
  description: Joi.string().trim().max(200).allow('').optional(),
  isDefault: Joi.boolean().optional(),
  billingAddress: Joi.object({
    street_address: Joi.string().trim().max(200).allow('').optional(),
    unit_number: Joi.string().trim().max(50).allow('').optional(),
    city: Joi.string().trim().max(100).allow('').optional(),
    state_province: Joi.string().trim().max(50).allow('').optional(),
    postal_code: Joi.string().trim().max(20).allow('').optional(),
    country_code: Joi.string().trim().max(2).allow('').optional(),
  }).optional(),
  entityType: entityType.optional(),
  entityId: objectId.optional(),
});

const deleteOwnerPaymentMethodSchema = Joi.object({
  entityType: entityType.optional(),
  entityId: objectId.optional(),
});

const payloadAccountIdParamSchema = Joi.object({
  accountId: objectId.required(),
});

const payloadDepositMethodIdParamSchema = Joi.object({
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

const executePayloadPayinSchema = Joi.object({
  invoiceId: objectId.required(),
  invoicePaymentAmount: Joi.number().positive().precision(2).required(),
  chargeAmount: Joi.number().positive().precision(2).optional(),
  paymentMethodId: Joi.string().trim().max(120).required(),
  paymentAttemptId: Joi.string().trim().max(120).required(),
  description: Joi.string().trim().max(500).optional(),
  /**
   * Multi-invoice owner pay: fee is charged on the first leg only.
   * Sibling legs set this true so server does not re-add processing fee.
   */
  skipPayerFeeAutofill: Joi.boolean().optional(),
  /**
   * Invoice ids already covered earlier in the same multi-pay attempt
   * (FIFO allocation). Used by ledger chronological payment guards.
   */
  coveredInvoiceIds: Joi.array().items(objectId).max(50).optional(),
});

const validatePayloadPayinAllocationsSchema = Joi.object({
  paymentMethodId: Joi.string().trim().max(120).required(),
  allocations: Joi.array().items(Joi.object({
    invoiceId: objectId.required(),
    invoicePaymentAmount: Joi.number().positive().precision(2).optional(),
  })).min(1).max(50).required(),
});

const payloadPayinIdParamSchema = Joi.object({
  payinId: Joi.alternatives().try(objectId, Joi.string().trim().max(120)).required(),
});

const requestPayloadRefundSchema = Joi.object({
  invoiceId: objectId.required(),
  paymentTransactionId: objectId.required(),
  amount: Joi.number().positive().precision(2).optional(),
  reason: Joi.string().valid('REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT').optional(),
  refundAttemptId: Joi.string().trim().max(120).required(),
});

const payloadRefundIdParamSchema = Joi.object({
  refundId: Joi.alternatives().try(objectId, Joi.string().trim().max(120)).required(),
});

const reconciliationQuerySchema = Joi.object({
  hoaId: objectId.required(),
  since: Joi.date().iso().optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
  includeFailedWebhooks: Joi.boolean().optional(),
});

const ownerAutopayHoaQuerySchema = Joi.object({
  hoaId: Joi.string().hex().length(24).required(),
});

const enableOwnerAutopaySchema = Joi.object({
  hoaId: Joi.string().hex().length(24).required(),
  paymentMethodLocalId: Joi.string().hex().length(24).required(),
  confirmAutopay: Joi.boolean().truthy('true').valid(true).required(),
});

const changeOwnerAutopayPaymentMethodSchema = Joi.object({
  hoaId: Joi.string().hex().length(24).required(),
  paymentMethodLocalId: Joi.string().hex().length(24).required(),
});

const disableOwnerAutopaySchema = Joi.object({
  hoaId: Joi.string().hex().length(24).required(),
});

/** Phase 3: read-only Vendor invoice pay eligibility */
const vendorInvoicePayEligibilityParamSchema = Joi.object({
  vendorInvoiceId: objectId.required(),
});

/** Phase 4: Owner → Vendor payin validate/execute */
const vendorInvoicePayinBodySchema = Joi.object({
  invoicePaymentAmount: Joi.number().positive().precision(2).required(),
  paymentMethodLocalId: objectId.required(),
  paymentAttemptId: Joi.string().trim().min(8).max(128).when('$requireAttemptId', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  description: Joi.string().trim().max(500).allow('').optional(),
});

const validateVendorInvoicePayinBodySchema = vendorInvoicePayinBodySchema.keys({
  paymentAttemptId: Joi.string().trim().min(8).max(128).optional(),
});

const executeVendorInvoicePayinBodySchema = vendorInvoicePayinBodySchema.keys({
  paymentAttemptId: Joi.string().trim().min(8).max(128).required(),
});

const vendorPayinIdParamSchema = Joi.object({
  vendorPayinId: objectId.required(),
});

module.exports = {
  initializeMerchantSchema,
  listMerchantsQuerySchema,
  merchantStatusQuerySchema,
  merchantSessionSchema,
  payloadAccountIdParamSchema,
  payloadDepositMethodIdParamSchema,
  initializeDepositMethodSchema,
  registerDepositMethodSchema,
  initializePaymentMethodSchema,
  initializePaymentMethodEditSchema,
  registerPaymentMethodSchema,
  executePayloadPayinSchema,
  validatePayloadPayinAllocationsSchema,
  payloadPayinIdParamSchema,
  requestPayloadRefundSchema,
  payloadRefundIdParamSchema,
  reconciliationQuerySchema,
  registerMerchantProcessingAccountSchema,
  listPaymentMethodsQuerySchema,
  payloadPaymentMethodLocalIdParamSchema,
  updateOwnerPaymentMethodSchema,
  deleteOwnerPaymentMethodSchema,
  ownerAutopayHoaQuerySchema,
  enableOwnerAutopaySchema,
  changeOwnerAutopayPaymentMethodSchema,
  disableOwnerAutopaySchema,
  vendorInvoicePayEligibilityParamSchema,
  validateVendorInvoicePayinBodySchema,
  executeVendorInvoicePayinBodySchema,
  vendorPayinIdParamSchema,
};
