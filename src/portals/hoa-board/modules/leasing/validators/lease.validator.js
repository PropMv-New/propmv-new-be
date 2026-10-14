/**
 * ------------------------------------------------------------------
 * File: lease.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * lease.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const moneyNum = Joi.number();

const additionalFeeItem = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().required(),
  quantity: Joi.number().required(),
  rate: Joi.number().required(),
  amount: Joi.number().required(),
});

const additionalFeesSchema = Joi.object({
  items: Joi.array().items(additionalFeeItem).optional(),
  totalAmount: Joi.number().required(),
  alreadyPaid: Joi.number().required(),
  balanceAmount: Joi.number().required(),
  isRecurringInvoice: Joi.boolean().required(),
  lineItemOnRentalInvoice: Joi.boolean().required(),
  dueDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().allow('', null)).when('isRecurringInvoice', { is: false, then: Joi.required() }),
  startDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().allow('', null)).when('isRecurringInvoice', { is: true, then: Joi.required() }),
  endDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().allow('', null)).when('isRecurringInvoice', { is: true, then: Joi.required() }),
  frequency: Joi.when('isRecurringInvoice', { is: true, then: Joi.string().optional(), otherwise: Joi.forbidden() }),
  notes: Joi.string().optional()
}).custom((val, helpers) => {
  if (val && val.isRecurringInvoice === true && !val.lineItemOnRentalInvoice && !val.frequency) {
    return helpers.message('additionalFees.frequency is required when isRecurringInvoice is true and lineItemOnRentalInvoice is false');
  }
  return val;
});

const rentDistributionSplitItem = Joi.object({
  tenantId: Joi.string().pattern(objectIdRegex).required(),
  rentAmount: Joi.number().required(),
  rentPercentage: Joi.number().required(),
  depositAmount: Joi.number().required(),
  depositPercentage: Joi.number().required(),
});

const rentAndDepositDestributionSchema = Joi.object({
  isAllTenantsEquallyResponsible: Joi.boolean().required(),
  isPartialPaymentAllowed: Joi.boolean().required(),
  rentDistributionType: Joi.string().required(),
  securityDepositDestributionType: Joi.string().required(),
  split: Joi.array().items(rentDistributionSplitItem).min(1).required(),
});

const rentDetailsSchema = Joi.object({
  amount: Joi.number().required(),
  firstRentalInvoiceDue: Joi.date().iso().required(),
  // optional client-provided fields
  frequency: Joi.string().optional(),
  dueOne: Joi.string().optional()
}).required();

const depositDetailsSchema = Joi.object({
  amount: Joi.number().optional(),
  due: Joi.date().iso().when('amount', { is: Joi.number().greater(0), then: Joi.required(), otherwise: Joi.optional() }),
  isDepositAlreadyCollected: Joi.boolean().required()
}).optional();

const createLeaseSchema = Joi.object({
  property_id: Joi.string().pattern(objectIdRegex).required(),
  unitName: Joi.string().allow('').optional(),
  leaseTerm: Joi.alternatives().try(Joi.number(), Joi.string()).required(),
  lease_type: Joi.string().required(),
  start_date: Joi.date().iso().required(),
  end_date: Joi.date().iso().when('lease_type', { is: Joi.string().valid('FixedTerm'), then: Joi.required(), otherwise: Joi.optional() }),
  switchMonthToMonth: Joi.boolean().when('lease_type', { is: Joi.string().valid('FixedTerm'), then: Joi.required(), otherwise: Joi.optional() }),
  auto_renew: Joi.boolean().optional(),
  rentDetails: rentDetailsSchema,
  depositDetails: depositDetailsSchema,
  additionalFees: additionalFeesSchema.optional(),
  rentAndDepositDestribution: rentAndDepositDestributionSchema.optional(),
  status: Joi.string().optional(),
    includeDamageReport: Joi.boolean().optional(),
});

// For update the earlier implementation expected the same full payload; keep same requirements
const updateLeaseSchema = createLeaseSchema;

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const listLeasesQuerySchema = Joi.object({
  property_id: Joi.string().pattern(objectIdRegex).optional(),
  unitName: Joi.string().optional(),
  status: Joi.string().optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional(),
  /** Appended by HOA board UI axios interceptor for portal routing */
  context: Joi.string().valid('hoa-board').optional(),
});

const listByLandlordQuerySchema = Joi.object({
  landlordId: Joi.string().pattern(objectIdRegex).required(),
  status: Joi.string().optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional()
});

const getLeaseByTenantQuerySchema = Joi.object({
  tenantId: Joi.string().pattern(objectIdRegex).required(),
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  unit: Joi.string().required()
});

const renewLeaseSchema = Joi.object({
  type: Joi.string().valid('Renew And Extend', 'Renew With New Lease').required()
}).concat(createLeaseSchema);

module.exports = {
  createLeaseSchema,
  updateLeaseSchema,
  idParamSchema,
  listLeasesQuerySchema,
  listByLandlordQuerySchema,
  getLeaseByTenantQuerySchema,
  renewLeaseSchema
};
