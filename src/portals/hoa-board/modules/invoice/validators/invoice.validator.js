/**
 * ------------------------------------------------------------------
 * File: invoice.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * invoice.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { INVOICE_TYPES, INVOICE_STATUS, GROUP_BY, INVOICE_TYPE_ENUM_VALUES } = require('../../../../../common/constants/invoice');
const { moneyAmount, moneyAmountOptional, quantityAmount } = require('../../../../../common/validators/money.schema');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const invoiceItemSchema = Joi.object({
  invoiceItem: Joi.string().required(),
  description: Joi.string().optional().allow('', null),
  quantity: quantityAmount({ min: 0 }),
  rate: moneyAmount({ min: 0 }),
  amount: moneyAmount({ min: 0 }),
});

const createInvoiceSchema = Joi.object({
  // Fields required by the Mongoose model
  invoiceId: Joi.string().optional(),
  type: Joi.string().valid(...INVOICE_TYPE_ENUM_VALUES).required(),
  isPartialPaymentAllowed: Joi.boolean().required(),
  propertyId: Joi.string().pattern(objectIdRegex).required(),
  unit: Joi.string().required(),
  term: Joi.string().required(),
  tenants: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).optional(),
  /** HOA alias for payers */
  hoaOwnerIds: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).optional(),
  isAllTenantSelected: Joi.boolean().optional(),
  /** HOA alias for selecting all payers */
  isAllHoaOwnerSelected: Joi.boolean().optional(),
  /** HOA alias for creator/filter semantics */
  hoaBoardMemberId: Joi.string().pattern(objectIdRegex).optional(),
  invoiceItemDetails: Joi.array().items(invoiceItemSchema).min(1).required(),
  subAmount: moneyAmount({ min: 0 }),
  alreadyPaid: moneyAmount({ min: 0 }),
  balanceDue: moneyAmount({ min: 0 }),
  isRecurringInvoice: Joi.boolean().required(),
  notes: Joi.string().optional().allow('', null),
  isLineItemOnRentalInvoice: Joi.boolean().optional(),
  dueDate: Joi.date().iso().required(),
  frequency: Joi.string().optional(),
  dueOnDate: Joi.number().integer().min(1).max(31).optional(),
  startDate: Joi.date().iso().when('isRecurringInvoice', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  endDate: Joi.date().iso().when('isRecurringInvoice', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  documents: Joi.array().items(Joi.string()).optional(),
  skipAutoLateFees: Joi.boolean().optional(),
  applyLateFeeNow: Joi.boolean().optional(),
}).custom((val, helpers) => {
  const hasTenants = Array.isArray(val.tenants) && val.tenants.length > 0;
  const hasHoaOwners = Array.isArray(val.hoaOwnerIds) && val.hoaOwnerIds.length > 0;
  if (!hasTenants && !hasHoaOwners) {
    return helpers.message('Either tenants or hoaOwnerIds is required');
  }

  if (
    typeof val.isAllTenantSelected === 'undefined' &&
    typeof val.isAllHoaOwnerSelected === 'undefined'
  ) {
    return helpers.message('Either isAllTenantSelected or isAllHoaOwnerSelected is required');
  }

  // isLineItemOnRentalInvoice can be set regardless of isAllTenantSelected
  // Remove the validation that requires isAllTenantSelected to be true

  // When recurring and line-item-on-rental is false, require frequency and dueOnDate
  if (val.isRecurringInvoice === true && (val.isLineItemOnRentalInvoice === false || typeof val.isLineItemOnRentalInvoice === 'undefined')) {
    if (!val.frequency) return helpers.message('frequency is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false');
    if (typeof val.dueOnDate === 'undefined' || val.dueOnDate === null) return helpers.message('dueOnDate is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false');
  }

  return val;
});

const updateInvoiceSchema = Joi.object({
  type: Joi.string().valid(...INVOICE_TYPE_ENUM_VALUES).optional(),
  isPartialPaymentAllowed: Joi.boolean().optional(),
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional(),
  term: Joi.string().optional(),
  tenants: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).optional(),
  hoaOwnerIds: Joi.array().items(Joi.string().pattern(objectIdRegex)).min(1).optional(),
  isAllTenantSelected: Joi.boolean().optional(),
  isAllHoaOwnerSelected: Joi.boolean().optional(),
  hoaBoardMemberId: Joi.string().pattern(objectIdRegex).optional(),
  invoiceItemDetails: Joi.array().items(invoiceItemSchema).min(1).optional(),
  subAmount: moneyAmountOptional({ min: 0 }),
  alreadyPaid: moneyAmountOptional({ min: 0 }),
  balanceDue: moneyAmountOptional({ min: 0 }),
  paidOn: Joi.date().iso().optional(),
  paymentMethod: Joi.string().optional(),
  paymentType: Joi.string().optional(),
  paymentUserId: Joi.string().pattern(objectIdRegex).optional(),
  checkNumber: Joi.string().optional().allow('', null),
  moneyOrderNumber: Joi.string().optional().allow('', null),
  paymentNotes: Joi.string().optional().allow('', null),
  /** Alias for paymentNotes (some clients send singular form) */
  paymentNote: Joi.string().optional().allow('', null),
  /** Incremental payment amount (preferred for record-payment; supports overpayment) */
  paymentAmount: moneyAmountOptional({ min: 0.01, positive: true }),
  isRecurringInvoice: Joi.boolean().optional(),
  notes: Joi.string().optional().allow('', null),
  isLineItemOnRentalInvoice: Joi.boolean().optional(),
  dueDate: Joi.date().iso().optional(),
  frequency: Joi.string().optional(),
  dueOnDate: Joi.number().integer().min(1).max(31).optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  documents: Joi.array().items(Joi.string()).optional(),
  depositBankAccountId: Joi.string().pattern(objectIdRegex).optional().allow('', null),
  depositBankAccountName: Joi.string().optional().allow('', null),
  balanceDepositBankAccountId: Joi.string().pattern(objectIdRegex).optional().allow('', null),
  balanceDepositBankAccountName: Joi.string().optional().allow('', null),
  documentToDelete: Joi.array().items(Joi.string().pattern(objectIdRegex)).optional(),
}).custom((val, helpers) => {
  // Remove the validation that requires isAllTenantSelected to be true for isLineItemOnRentalInvoice

  if (typeof val.isRecurringInvoice !== 'undefined' && val.isRecurringInvoice === true) {
    // if frequency or dueOnDate are present, they must be valid; if caller explicitly sets isLineItemOnRentalInvoice to false then require them
    if (val.isLineItemOnRentalInvoice === false) {
      if (!val.frequency) return helpers.message('frequency is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false');
      if (typeof val.dueOnDate === 'undefined' || val.dueOnDate === null) return helpers.message('dueOnDate is required when isRecurringInvoice is true and isLineItemOnRentalInvoice is false');
    }
  }

  return val;
});

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

/** Virtual list filters (not stored enum values on the document) */
const HOA_INVOICE_LIST_STATUS_FILTERS = ['Collected', 'Coming Due', 'Due'];

const listQuerySchema = Joi.object({
  propertyId: Joi.string().pattern(objectIdRegex).optional(),
  landlordId: Joi.string().pattern(objectIdRegex).optional(),
  context: Joi.string().valid('hoa-board').optional(),
  unit: Joi.string().optional(),
  tenantId: Joi.string().pattern(objectIdRegex).optional(),
  /** HOA board: same as tenantId (invoice payers are owners) */
  ownerId: Joi.string().pattern(objectIdRegex).optional(),
  /** HOA alias for owner filter */
  hoaOwnerId: Joi.string().pattern(objectIdRegex).optional(),
  /** HOA alias for createdBy filter */
  hoaBoardMemberId: Joi.string().pattern(objectIdRegex).optional(),
  paymentMethod: Joi.string().optional(),
  invoiceId: Joi.string().pattern(objectIdRegex).optional(),
  invoiceType: Joi.string().valid(...INVOICE_TYPE_ENUM_VALUES).optional(),
  status: Joi.string()
    .valid(...Object.values(INVOICE_STATUS), ...HOA_INVOICE_LIST_STATUS_FILTERS)
    .optional(),
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sentOn: Joi.date().iso().optional(),
  paidOn: Joi.date().iso().optional(),
  groupBy: Joi.string().valid(...Object.values(GROUP_BY)).optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).optional(),
  // Additional filters based on invoice model
  leaseId: Joi.string().pattern(objectIdRegex).optional(),
  minAmount: moneyAmountOptional({ min: 0 }),
  maxAmount: moneyAmountOptional({ min: 0 }),
  isPartialPaymentAllowed: Joi.boolean().optional(),
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  timePeriod: Joi.string().valid('month', 'quarter', 'half-year', 'year').optional(),
  search: Joi.string().optional().allow(''),
  sortBy: Joi.string().valid(
    'dueDate',
    'createdAt',
    'updatedAt',
    'subAmount',
    'balanceDue',
    'alreadyPaid',
    'status',
    'propertyName',
    'unit',
    'invoiceId',
    'paidOn'
  ).optional(),
  sortOrder: Joi.string().valid('asc', 'desc', 'ASC', 'DESC').optional(),
  /** HOA owner listing: when true with this_month start/end, also surface prior-period unpaid due invoices */
  includePastDueOutstanding: Joi.boolean().optional(),
}).custom((val, helpers) => {
  // startDate / endDate may be used alone (e.g. Past Overdue = due on or before endDate).
  if (val.minAmount && val.maxAmount && val.minAmount > val.maxAmount) {
    return helpers.message('minAmount cannot be greater than maxAmount');
  }
  return val;
});

const addCommentSchema = Joi.object({
  text: Joi.string().required().min(1)
});

const noteIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
  noteId: Joi.string().hex().length(24).required(),
});

const paymentIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
  paymentId: Joi.string().hex().length(24).required(),
});

const entityNotePayloadSchema = Joi.object({
  description: Joi.string().trim().max(5000).allow('').optional(),
  text: Joi.string().trim().max(5000).allow('').optional(),
  title: Joi.string().trim().max(200).allow('').optional(),
  isPinned: Joi.boolean().optional(),
  isImportant: Joi.boolean().optional(),
  reminder: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null)).optional(),
}).unknown(true);

const updateEntityNoteSchema = Joi.object({
  description: Joi.string().trim().min(1).max(5000).optional(),
  text: Joi.string().trim().min(1).max(5000).optional(),
  title: Joi.string().trim().max(200).allow('').optional(),
  isPinned: Joi.boolean().optional(),
  isImportant: Joi.boolean().optional(),
  reminder: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null)).optional(),
  removeAttachmentIds: Joi.alternatives()
    .try(
      Joi.array().items(Joi.string().pattern(objectIdRegex)),
      Joi.string().trim(),
    )
    .optional(),
}).unknown(true);

const sendReminderSchema = Joi.object({
  to: Joi.alternatives().try(
    Joi.string().email(),
    Joi.array().items(Joi.string().email()).min(1)
  ).required(),
  subject: Joi.string().min(1).max(200).required(),
  emailBody: Joi.string().allow('').optional(),
  ownerName: Joi.string().allow('').optional(),
  invoiceType: Joi.string().allow('').optional(),
  senderCompany: Joi.string().allow('').optional(),
  senderPhone: Joi.string().allow('').optional(),
  senderEmail: Joi.string().email().allow('').optional(),
});

const waiveInvoiceSchema = Joi.object({
  lineItemIndex: Joi.number().integer().min(0).required(),
  reason: Joi.string().trim().min(1).max(2000).required(),
});

const reverseWaiveInvoiceSchema = Joi.object({}).unknown(false);

/** Bulk generate endpoints currently take no body; reject unexpected payloads. */
const generateBulkInvoicesSchema = Joi.object({}).unknown(false);

const allocationPreviewQuerySchema = Joi.object({
  amount: moneyAmount({ min: 0.01, positive: true }),
  allocateFutureInvoices: Joi.boolean().optional(),
  // Portal SPA tag (board + owner share the HOA SPA); role comes from JWT, not this field.
  context: Joi.string().valid('hoa-board').optional(),
});

module.exports = {
  createInvoiceSchema,
  updateInvoiceSchema,
  idParamSchema,
  listQuerySchema,
  addCommentSchema,
  noteIdParamSchema,
  paymentIdParamSchema,
  entityNotePayloadSchema,
  updateEntityNoteSchema,
  sendReminderSchema,
  waiveInvoiceSchema,
  reverseWaiveInvoiceSchema,
  generateBulkInvoicesSchema,
  allocationPreviewQuerySchema,
};
