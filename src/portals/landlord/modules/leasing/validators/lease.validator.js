/**
 * ------------------------------------------------------------------
 * File: lease.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * lease.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { FREQUENCY_TYPES } = require('../../../../../common/constants/lease');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const {
  toStoredLeaseDate,
  assertSemiAnnualFeeDatesInTenure,
} = require('../helpers/leaseDate.helpers');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const moneyNum = Joi.number();

const additionalFeeItem = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().optional().allow('', null),
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
  // dueDate - required only when isRecurringInvoice is false (one-time fee)
  dueDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().allow('', null)).when('isRecurringInvoice', { is: false, then: Joi.required(), otherwise: Joi.optional().allow(null) }),
  // For recurring invoices
  startDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().allow('', null)).when('isRecurringInvoice', { is: true, then: Joi.required() }),
  endDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().allow('', null)).when('isRecurringInvoice', { is: true, then: Joi.required() }),
  frequency: Joi.string().optional().allow(null),
  // Due date fields - all optional, presence depends on frequency
  dueOnDate: Joi.number().min(1).max(31).optional().allow(null),
  dueOnDate2: Joi.number().min(1).max(31).optional().allow(null),
  dueWeekday: Joi.number().min(0).max(6).optional().allow(null),
  semiAnnualDates: Joi.array().items(
    Joi.object({
      month: Joi.number().min(1).max(12).required(),
      day: Joi.number().min(1).max(31).required()
    })
  ).optional().allow(null),
  notes: Joi.string().optional()
}).custom((val, helpers) => {
  // If not recurring, make sure only dueDate is set
  if (val && val.isRecurringInvoice === false) {
    if (!val.dueDate) {
      return helpers.message('additionalFees.dueDate is required when isRecurringInvoice is false');
    }
    return val;
  }
  
  // If recurring and NOT a line item, ensure frequency is set
  if (val && val.isRecurringInvoice === true && val.lineItemOnRentalInvoice === false) {
    if (!val.frequency) {
      return helpers.message('additionalFees.frequency is required when isRecurringInvoice is true and lineItemOnRentalInvoice is false');
    }
    
    // Validate due date fields based on frequency
    const freq = val.frequency.toLowerCase();
    
    if (freq === 'monthly' && val.dueOnDate === undefined && val.dueOnDate === null) {
      return helpers.message('additionalFees.dueOnDate is required for monthly recurring fees');
    }
    
    if (freq === 'bi-monthly' && (!val.dueOnDate || !val.dueOnDate2)) {
      return helpers.message('additionalFees.dueOnDate and dueOnDate2 are required for bi-monthly recurring fees');
    }
    
    if ((freq === 'weekly' || freq === 'bi-weekly') && val.dueWeekday === undefined && val.dueWeekday === null) {
      return helpers.message(`additionalFees.dueWeekday is required for ${freq} recurring fees`);
    }
    
    if (freq === 'semi-annually' && (!val.semiAnnualDates || val.semiAnnualDates.length !== 2)) {
      return helpers.message('additionalFees.semiAnnualDates is required for semi-annually recurring fees (must have 2 dates)');
    }
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
  frequency: Joi.string().valid(...Object.values(FREQUENCY_TYPES)).required(),
  firstRentalInvoiceDue: Joi.date().iso().required(),
  // Conditional fields based on frequency
  dueOne: Joi.string().optional(),
  dueTwo: Joi.string().when('frequency', { is: FREQUENCY_TYPES.BI_MONTHLY, then: Joi.required(), otherwise: Joi.optional() }),
  dueWeekday: Joi.number().min(0).max(6).when('frequency', { 
    is: Joi.string().valid(FREQUENCY_TYPES.WEEKLY, FREQUENCY_TYPES.BI_WEEKLY), 
    then: Joi.required(), 
    otherwise: Joi.optional() 
  }),
  semiAnnualDates: Joi.array().items(
    Joi.object({
      month: Joi.number().min(1).max(12).required(),
      day: Joi.number().min(1).max(31).required()
    })
  ).when('frequency', { 
    is: FREQUENCY_TYPES.SEMI_ANNUALLY, 
    then: Joi.array().length(2).required(), 
    otherwise: Joi.optional() 
  })
}).required();

const depositDetailsSchema = Joi.object({
  amount: Joi.number().optional(),
  due: Joi.date().iso().when('amount', { is: Joi.number().greater(0), then: Joi.required(), otherwise: Joi.optional() }),
  isDepositAlreadyCollected: Joi.boolean().required()
}).optional();

const createLeaseSchema = Joi.object({
  property_id: Joi.string().pattern(objectIdRegex).required(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unitName: Joi.string().allow('').optional(),
  leaseTerm: Joi.alternatives().try(Joi.number(), Joi.string()).required(),
  lease_type: Joi.string().required(),
  start_date: Joi.date().iso().required(),
  end_date: Joi.date().iso().when('lease_type', { is: Joi.string().valid('FixedTerm'), then: Joi.required(), otherwise: Joi.optional() }),
  switchMonthToMonth: Joi.boolean().when('lease_type', { is: Joi.string().valid('FixedTerm'), then: Joi.required(), otherwise: Joi.optional() }),
  auto_renew: Joi.boolean().optional(),
  rentDetails: rentDetailsSchema,
  depositDetails: depositDetailsSchema,
  additionalFees: Joi.array().items(additionalFeesSchema).optional(),
  generatedInvoices: Joi.array().items(
    Joi.object({
      type: Joi.string().valid('rent', 'deposit', 'additional-fee').required(),
      description: Joi.string().required(),
      amount: Joi.number().min(0).required(),
      dueDate: Joi.date().iso().required(),
      frequency: Joi.string().optional().allow('', null),
      status: Joi.string().valid(...Object.values(INVOICE_STATUS)).required(),
      feeId: Joi.string().optional().allow('', null),
      feeName: Joi.string().optional().allow('', null),
      tenantId: Joi.string().optional().allow('', null),
      tenantName: Joi.string().optional().allow('', null),
    })
  ).optional(),
  rentAndDepositDestribution: rentAndDepositDestributionSchema.optional(),
  requireInsurance: Joi.boolean().optional(),
  insuranceTenantsIds: Joi.array().items(Joi.string()).optional(),
  includeDamageReport: Joi.boolean().optional(),
  status: Joi.string().optional(),
}).custom((val, helpers) => {
  if (val.additionalFees && Array.isArray(val.additionalFees) && val.start_date) {
    try {
      assertSemiAnnualFeeDatesInTenure(
        val.additionalFees,
        toStoredLeaseDate(val.start_date),
        val.end_date ? toStoredLeaseDate(val.end_date) : null
      );
    } catch (error) {
      return helpers.message(error.message);
    }
  }
  return val;
}).custom((val, helpers) => {
  const hasUnit =
    (val.unitId && objectIdRegex.test(String(val.unitId))) ||
    (val.unitName != null && String(val.unitName).trim() !== '');
  if (!hasUnit) {
    return helpers.message('Either unitId or unitName is required');
  }
  return val;
});

// For update the earlier implementation expected the same full payload; keep same requirements
const updateLeaseSchema = createLeaseSchema;

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const listLeasesQuerySchema = Joi.object({
  property_id: Joi.string().pattern(objectIdRegex).optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unitName: Joi.string().optional(),
  status: Joi.string().optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(0).optional()
});

const listByLandlordQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).allow('').optional(),
  status: Joi.string().optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  search: Joi.string().allow('').optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).optional()
});

const getLeaseByTenantQuerySchema = Joi.object({
  tenantId: Joi.string().pattern(objectIdRegex).required(),
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  unit: Joi.string().optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
}).custom((val, helpers) => {
  if (!val.unit && !val.unitId) {
    return helpers.message('Either unit or unitId is required');
  }
  return val;
});

const renewLeaseSchema = Joi.object({
  type: Joi.string().valid('Renew And Extend', 'Renew With New Lease').required()
}).concat(createLeaseSchema);

const exportQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  status: Joi.string().optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  format: Joi.string().valid('csv', 'xlsx', 'excel', 'json').optional(),
});

const tenureAvailabilityQuerySchema = Joi.object({
  property_id: Joi.string().pattern(objectIdRegex).required(),
  unit_id: Joi.string().pattern(objectIdRegex).optional(),
  unitName: Joi.string().allow('').optional(),
  lease_type: Joi.string().valid('FixedTerm', 'MonthToMonth').required(),
  start_date: Joi.date().iso().required(),
  end_date: Joi.date().iso().when('lease_type', {
    is: 'FixedTerm',
    then: Joi.required(),
    otherwise: Joi.optional().allow(null, ''),
  }),
  exclude_lease_id: Joi.string().pattern(objectIdRegex).optional(),
}).custom((val, helpers) => {
  const hasUnit =
    (val.unit_id && objectIdRegex.test(String(val.unit_id))) ||
    (val.unitName != null && String(val.unitName).trim() !== '');
  if (!hasUnit) {
    return helpers.message('Either unit_id or unitName is required');
  }
  return val;
});

module.exports = {
  createLeaseSchema,
  updateLeaseSchema,
  idParamSchema,
  listLeasesQuerySchema,
  listByLandlordQuerySchema,
  getLeaseByTenantQuerySchema,
  renewLeaseSchema,
  exportQuerySchema,
  tenureAvailabilityQuerySchema,
};
