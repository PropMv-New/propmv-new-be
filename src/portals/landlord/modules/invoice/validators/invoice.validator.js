/**
 * ------------------------------------------------------------------
 * File: invoice.validator.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * invoice.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { INVOICE_TYPES, INVOICE_STATUS, GROUP_BY } = require('../../../../../common/constants/invoice');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { moneyAmount, moneyAmountOptional, quantityAmount } = require('../../../../../common/validators/money.schema');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const invoiceItemSchema = Joi.object({
  invoiceItem: Joi.string().required(),
  description: Joi.string().optional().allow('', null),
  quantity: quantityAmount({ min: 0 }),
  rate: moneyAmount({ min: 0 }),
  amount: moneyAmount({ min: 0 }),
  notes: Joi.string().optional().allow('', null),
});

const createInvoiceSchema = Joi.object({
  // Fields required by the Mongoose model
  invoiceId: Joi.string().optional(),
  type: Joi.string().valid(...Object.values(INVOICE_TYPES)).required(),
  isPartialPaymentAllowed: Joi.boolean().required(),
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().when('unitId', {
    is: Joi.exist(),
    then: Joi.optional().allow(''),
    otherwise: Joi.required(),
  }),
  term: Joi.string().required(),
  tenants: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).required(),
  isAllTenantSelected: Joi.boolean().required(),
  invoiceItemDetails: Joi.array().items(invoiceItemSchema).min(1).required(),
  subAmount: moneyAmount({ min: 0 }),
  alreadyPaid: moneyAmount({ min: 0 }),
  balanceDue: moneyAmount({ min: 0 }),
  notes: Joi.string().optional().allow('', null),
  isRecurringInvoice: Joi.boolean().required(),
  isLineItemOnRentalInvoice: Joi.boolean().optional(),
  dueDate: Joi.date().iso().required(),
  leaseId: Joi.string().pattern(objectIdRegex).optional(),
  invoiceDetails: Joi.array().items(
    Joi.object({
      dueDate: Joi.date().iso().required(),
      amount: moneyAmount({ min: 0 }),
      alreadyPaid: moneyAmountOptional({ min: 0 }),
      paymentDate: Joi.date().iso().optional(),
      status: Joi.string().optional(),
      description: Joi.string().optional().allow('', null),
      scheduleKey: Joi.string().optional().allow('', null),
      invoiceItemDetails: Joi.array().items(invoiceItemSchema).optional()
    })
  ).optional(),
  frequency: Joi.string().optional(),
  dueOnDate: Joi.number().integer().min(1).max(31).optional(),
  startDate: Joi.date().iso().when('isRecurringInvoice', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  endDate: Joi.date().iso().when('isRecurringInvoice', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  documents: Joi.array().items(Joi.string()).optional(),
}).custom((val, helpers) => {
  // isLineItemOnRentalInvoice is only applicable for recurring invoices
  if (typeof val.isLineItemOnRentalInvoice !== 'undefined' && val.isLineItemOnRentalInvoice === true && val.isRecurringInvoice !== true) {
    return helpers.message('isLineItemOnRentalInvoice can only be set when isRecurringInvoice is true');
  }

  // If recurring and line-item-on-rental is true, require All Tenants to be selected
  if (val.isRecurringInvoice === true && val.isLineItemOnRentalInvoice === true && val.isAllTenantSelected !== true) {
    return helpers.message('isLineItemOnRentalInvoice can only be set when isAllTenantSelected is true');
  }

  // When recurring and line-item-on-rental is false, require frequency and dueOnDate
  if (val.isRecurringInvoice === true && (val.isLineItemOnRentalInvoice === false || typeof val.isLineItemOnRentalInvoice === 'undefined')) {
    if (!val.frequency) return helpers.message('frequency is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false or not set');
    if (typeof val.dueOnDate === 'undefined' || val.dueOnDate === null) return helpers.message('dueOnDate is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false or not set');
  }

  // When recurring and line-item-on-rental is true, frequency and dueOnDate are not required
  // as it will follow the rental invoice schedule

  return val;
});

const updateInvoiceSchema = Joi.object({
  type: Joi.string().valid(...Object.values(INVOICE_TYPES)).optional(),
  isPartialPaymentAllowed: Joi.boolean().optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional(),
  term: Joi.string().optional(),
  tenants: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).optional(),
  isAllTenantSelected: Joi.boolean().optional(),
  invoiceItemDetails: Joi.array().items(invoiceItemSchema).min(1).optional(),
  subAmount: moneyAmountOptional({ min: 0 }),
  alreadyPaid: moneyAmountOptional({ min: 0 }),
  paymentAmount: moneyAmountOptional({ min: 0 }),
  balanceDue: moneyAmountOptional({ min: 0 }),
  paidOn: Joi.date().iso().optional(),
  paymentMethod: Joi.string().optional().allow('', null),
  paymentType: Joi.string().optional().allow('', null),
  paymentUserId: Joi.string().pattern(objectIdRegex).optional(),
  checkNumber: Joi.string().optional().allow('', null),
  moneyOrderNumber: Joi.string().optional().allow('', null),
  paymentNotes: Joi.string().optional().allow('', null),
  paymentNote: Joi.string().optional().allow('', null),
  notes: Joi.string().optional().allow('', null),
  isRecurringInvoice: Joi.boolean().optional(),
  isLineItemOnRentalInvoice: Joi.boolean().optional(),
  dueDate: Joi.date().iso().optional(),
  leaseId: Joi.string().pattern(objectIdRegex).optional(),
  documentToDelete: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional(),
  deletePaymentIds: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional(),
  isManual: Joi.boolean().optional(),
  invoiceDetails: Joi.array().items(
    Joi.object({
      dueDate: Joi.date().iso().required(),
      amount: moneyAmount({ min: 0 }),
      alreadyPaid: moneyAmountOptional({ min: 0 }),
      paymentDate: Joi.date().iso().optional(),
      status: Joi.string().optional(),
      description: Joi.string().optional().allow('', null),
      scheduleKey: Joi.string().optional().allow('', null),
      invoiceItemDetails: Joi.array().items(invoiceItemSchema).optional()
    })
  ).optional(),
  frequency: Joi.string().optional(),
  dueOnDate: Joi.number().integer().min(1).max(31).optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  documents: Joi.array().items(Joi.string()).optional(),
}).custom((val, helpers) => {
  // replicate the same conditional checks as create but allow partial updates
  // If caller sets isLineItemOnRentalInvoice=true on update and explicitly sets isRecurringInvoice, it must be true
  if (typeof val.isLineItemOnRentalInvoice !== 'undefined' && val.isLineItemOnRentalInvoice === true && typeof val.isRecurringInvoice !== 'undefined' && val.isRecurringInvoice !== true) {
    return helpers.message('isLineItemOnRentalInvoice can only be set when isRecurringInvoice is true');
  }

  if (typeof val.isLineItemOnRentalInvoice !== 'undefined' && val.isLineItemOnRentalInvoice === true && typeof val.isAllTenantSelected !== 'undefined' && val.isAllTenantSelected !== true) {
    return helpers.message('isLineItemOnRentalInvoice can only be set when isAllTenantSelected is true');
  }

  if (typeof val.isRecurringInvoice !== 'undefined' && val.isRecurringInvoice === true) {
    // if frequency or dueOnDate are present, they must be valid; if caller explicitly sets isLineItemOnRentalInvoice to false then require them
    if (val.isLineItemOnRentalInvoice === false) {
      if (!val.frequency) return helpers.message('frequency is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false');
      if (typeof val.dueOnDate === 'undefined' || val.dueOnDate === null) return helpers.message('dueOnDate is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false');
    }
  }

  // Validate that paidOn is required when alreadyPaid > 0
  if (typeof val.alreadyPaid !== 'undefined' && val.alreadyPaid > 0) {
    if (!val.paidOn) {
      return helpers.message('paidOn is required when alreadyPaid is greater than 0');
    }
  }

  return val;
});

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const invoiceStatusValues = Object.values(INVOICE_STATUS);
const isValidStatusList = (value) => {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((s) => invoiceStatusValues.includes(s));
};

const listQuerySchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional(),
  tenantId: Joi.string().pattern(objectIdRegex).optional(),
  paymentMethod: Joi.string().optional(),
  invoiceId: Joi.string().pattern(objectIdRegex).optional(),
  invoiceType: Joi.string().valid(...Object.values(INVOICE_TYPES)).optional(),
  status: Joi.string().custom((value, helpers) => {
    if (!isValidStatusList(value)) {
      return helpers.message(`status must be one of: ${invoiceStatusValues.join(', ')} (or comma-separated list)`);
    }
    return value;
  }).optional(),
  // Accept either ISO date or simple YYYY-MM-DD strings from frontend
  startDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  endDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  sentOn: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  paidOn: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  groupBy: Joi.string().valid(...Object.values(GROUP_BY)).optional(),
  sortBy: Joi.string().optional(),
  sortOrder: Joi.string().valid('asc','desc','ASC','DESC').optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).optional(),
  // Additional filters based on invoice model
  leaseId: Joi.string().pattern(objectIdRegex).optional(),
  minAmount: moneyAmountOptional({ min: 0 }),
  maxAmount: moneyAmountOptional({ min: 0 }),
  isPartialPaymentAllowed: Joi.boolean().optional(),
  /** Dashboard finance widget bucket - matches dashboard stats categorization */
  dashboardBucket: Joi.string()
    .valid('total', 'collected', 'overdue', 'coming_due', 'processing')
    .optional(),
  /** Alias for dashboardBucket (legacy / alternate param name) */
  dashboardStatus: Joi.string()
    .valid('total', 'collected', 'overdue', 'coming_due', 'processing')
    .optional(),
  searchText: Joi.string().trim().max(200).optional(),
}).custom((val, helpers) => {
  if ((val.startDate && !val.endDate) || (!val.startDate && val.endDate)) {
    return helpers.message('Both startDate and endDate must be present together');
  }
  if (val.minAmount && val.maxAmount && val.minAmount > val.maxAmount) {
    return helpers.message('minAmount cannot be greater than maxAmount');
  }
  return val;
});

const addCommentSchema = Joi.object({
  text: Joi.string().required().min(1)
});

const exportQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional(),
  tenantId: Joi.string().pattern(objectIdRegex).optional(),
  invoiceType: Joi.string().valid(...Object.values(INVOICE_TYPES)).optional(),
  status: Joi.string().custom((value, helpers) => {
    if (!isValidStatusList(value)) {
      return helpers.message(`status must be one of: ${invoiceStatusValues.join(', ')} (or comma-separated list)`);
    }
    return value;
  }).optional(),
  startDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  endDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  format: Joi.string().valid('csv', 'xlsx', 'excel', 'json').optional(),
  sortBy: Joi.string().optional(),
  sortOrder: Joi.string().valid('asc','desc','ASC','DESC').optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).optional(),
  dashboardBucket: Joi.string()
    .valid('total', 'collected', 'overdue', 'coming_due', 'processing')
    .optional(),
  dashboardStatus: Joi.string()
    .valid('total', 'collected', 'overdue', 'coming_due', 'processing')
    .optional(),
}).custom((val, helpers) => {
  if ((val.startDate && !val.endDate) || (!val.startDate && val.endDate)) {
    return helpers.message('Both startDate and endDate must be present together');
  }
  return val;
});

module.exports = {
  createInvoiceSchema,
  updateInvoiceSchema,
  idParamSchema,
  listQuerySchema,
  addCommentSchema,
  exportQuerySchema,
};
