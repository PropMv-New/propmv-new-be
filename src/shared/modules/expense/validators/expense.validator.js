/**
 * ------------------------------------------------------------------
 * File: expense.validator.js
 * Module: Expense Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * expense.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { EXPENSE_STATUS_VALUES } = require('../../../../common/constants/expense');
const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const payeeSchema = Joi.object({
  name: Joi.string().max(200).required(),
  contact: Joi.string().max(200).optional().allow('', null),
  phone: Joi.string().max(50).optional().allow('', null),
  email: Joi.string().email().optional().allow('', null),
  website: Joi.string().uri().optional().allow('', null)
});

const expenseItemSchema = Joi.object({
  _id: Joi.string().pattern(objectIdRegex).optional(),
  date: Joi.date().iso().required(),
  category: Joi.string().max(100).required(),
  description: Joi.string().max(500).required(),
  amount: Joi.number().min(0).required(),
  removeReceipt: Joi.boolean().optional(),
  fileDocument: Joi.object({
    metadataId: Joi.string().pattern(objectIdRegex).optional(),
    originalName: Joi.string().optional(),
    uploadedAt: Joi.date().iso().optional()
  }).optional()
});

const createExpenseSchema = Joi.object({
  // Expense Details
  taxableEntity: Joi.string().max(200).required(),
  bankAccount: Joi.string().max(200).required(),
  property: Joi.string().pattern(objectIdRegex).required(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().max(100).when('unitId', {
    is: Joi.exist(),
    then: Joi.optional().allow(''),
    otherwise: Joi.required(),
  }),
  payees: Joi.array().items(payeeSchema).min(1).required(),

  // Expense Items
  expenseItems: Joi.array().items(expenseItemSchema).min(1).required(),

  // Additional fields
  vendorPaidTo: Joi.string().max(200).optional().allow('', null),
  expenseDate: Joi.date().iso().required(),
  dueDate: Joi.date().iso().required(),
  paymentDate: Joi.date().iso().optional().allow(null),
  markAsPaid: Joi.boolean().optional().default(false),
  // status still accepted for backwards compat; create service only honors markAsPaid / paid
  status: Joi.string().valid(...EXPENSE_STATUS_VALUES).optional()
}).custom((val, helpers) => {
  if (!val.unit && !val.unitId) {
    return helpers.message('Either unit or unitId is required');
  }
  return val;
});

const updateExpenseSchema = Joi.object({
  // Expense Details - same as create but all optional
  taxableEntity: Joi.string().max(200).required(),
  bankAccount: Joi.string().max(200).required(),
  property: Joi.string().pattern(objectIdRegex).required(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().max(100).when('unitId', {
    is: Joi.exist(),
    then: Joi.optional().allow(''),
    otherwise: Joi.required(),
  }),
  payees: Joi.array().items(payeeSchema).min(1).optional(),

  // Expense Items - same as create but optional
  expenseItems: Joi.array().items(expenseItemSchema).min(1).optional(),

  // Additional fields - same as create but optional
  vendorPaidTo: Joi.string().max(200).optional().allow('', null),
  expenseDate: Joi.date().iso().optional(),
  dueDate: Joi.date().iso().optional(),
  paymentDate: Joi.date().iso().optional().allow(null),
  status: Joi.string().valid(...EXPENSE_STATUS_VALUES).optional()
}).min(1).custom((val, helpers) => {
  if (!val.unit && !val.unitId) {
    return helpers.message('Either unit or unitId is required');
  }
  return val;
});

const listQuerySchema = Joi.object({
  property: Joi.string().pattern(objectIdRegex).optional(),
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  vendorPaidTo: Joi.string().optional().allow('', null),
  category: Joi.string().optional().allow('', null),
  payee: Joi.string().optional().allow('', null),
  status: Joi.string().valid(...EXPENSE_STATUS_VALUES).optional(),
  // Accept either an ISO date or a simple YYYY-MM-DD string from the frontend
  startDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  endDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  dueStartDate: Joi.date().iso().optional(),
  dueEndDate: Joi.date().iso().optional(),
  paymentStartDate: Joi.date().iso().optional(),
  paymentEndDate: Joi.date().iso().optional(),
  // Sorting options forwarded from frontend
  sortBy: Joi.string().optional(),
  sortOrder: Joi.string().valid('asc','desc','ASC','DESC').optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional(),
  taxableEntity: Joi.string().optional(),
  bankAccount: Joi.string().optional(),
  minAmount: Joi.number().min(0).optional(),
  maxAmount: Joi.number().min(0).optional(),
  pageNumber: Joi.number().integer().min(1).default(1),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().optional().allow('', null)
}).custom((val, helpers) => {
  if ((val.startDate && !val.endDate) || (!val.startDate && val.endDate)) {
    return helpers.message('Both startDate and endDate must be present together');
  }
  if ((val.dueStartDate && !val.dueEndDate) || (!val.dueStartDate && val.dueEndDate)) {
    return helpers.message('Both dueStartDate and dueEndDate must be present together');
  }
  if ((val.paymentStartDate && !val.paymentEndDate) || (!val.paymentStartDate && val.paymentEndDate)) {
    return helpers.message('Both paymentStartDate and paymentEndDate must be present together');
  }
  if (val.minAmount && val.maxAmount && val.minAmount > val.maxAmount) {
    return helpers.message('minAmount cannot be greater than maxAmount');
  }
  return val;
});

const exportQuerySchema = Joi.object({
  createdBy: Joi.string().pattern(objectIdRegex).optional(),
  property: Joi.string().pattern(objectIdRegex).optional(),
  vendorPaidTo: Joi.string().optional().allow('', null),
  category: Joi.string().optional().allow('', null),
  status: Joi.string().valid(...EXPENSE_STATUS_VALUES).optional(),
  startDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  endDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  format: Joi.string().valid('csv', 'xlsx', 'excel', 'json').optional(),
  pageNumber: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(100).optional()
}).custom((val, helpers) => {
  if ((val.startDate && !val.endDate) || (!val.startDate && val.endDate)) {
    return helpers.message('Both startDate and endDate must be present together');
  }
  return val;
});

// POST /expense/:id/notes - "text" or "content" (at least one, non-empty after trim)
const addNoteSchema = Joi.object({
  text: Joi.string().trim().min(1).max(1000).optional(),
  content: Joi.string().trim().min(1).max(1000).optional()
})
  .or('text', 'content')
  .unknown(true);

const markPaidSchema = Joi.object({
  comment: Joi.string().trim().max(1000).optional().allow('', null)
});

module.exports = {
  idParamSchema,
  createExpenseSchema,
  updateExpenseSchema,
  listQuerySchema,
  exportQuerySchema,
  addNoteSchema,
  markPaidSchema
};
