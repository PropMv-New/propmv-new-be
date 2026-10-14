/**
 * ------------------------------------------------------------------
 * File: expense.validator.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * expense.routes
 * ------------------------------------------------------------------
 */

const Joi = require('joi');
const { EXPENSE_STATUS_VALUES, EXPENSE_STATUS } = require('../../../../../common/constants/expense');
const { moneyAmount, moneyAmountOptional } = require('../../../../../common/validators/money.schema');
const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const idParamSchema = Joi.object({ id: Joi.string().pattern(objectIdRegex).required() });

const payeeSchema = Joi.object({
  name: Joi.string().max(200).required(),
  contact: Joi.string().max(200).optional().allow('', null),
  phone: Joi.string().max(50).optional().allow('', null),
  email: Joi.string().email().optional().allow('', null),
  website: Joi.string().uri().optional().allow('', null),
  payeeType: Joi.string().max(100).optional().allow('', null),
  payeeId: Joi.string().pattern(objectIdRegex).optional().allow('', null)
});

const expenseItemSchema = Joi.object({
  date: Joi.date().iso().required(),
  category: Joi.string().max(100).required(),
  description: Joi.string().max(500).optional().allow('', null),
  amount: moneyAmount({ min: 0 }),
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
  property: Joi.string().pattern(objectIdRegex).optional().allow('', null),
  unitId: Joi.string().pattern(objectIdRegex).optional().allow('', null),
  unit: Joi.string().max(100).optional().allow('', null),
  payees: Joi.array().items(payeeSchema).min(1).required(),
  
  // Expense Items
  expenseItems: Joi.array().items(expenseItemSchema).min(1).required(),
  
  // Additional fields
  vendorPaidTo: Joi.string().max(200).optional().allow('', null),
  expenseDate: Joi.date().iso().required(),
  dueDate: Joi.date().iso().required(),
  paymentDate: Joi.date().iso().optional().allow(null),
  // Explicit create-time paid flag (preferred over raw status from the client)
  markAsPaid: Joi.boolean().optional().default(false),
  // status still accepted for backwards compat but create service only honors markAsPaid / paid
  status: Joi.string().valid(...EXPENSE_STATUS_VALUES).optional()
});

const updateExpenseSchema = Joi.object({
  // Expense Details - same as create but all optional
  taxableEntity: Joi.string().max(200).optional(),
  bankAccount: Joi.string().max(200).optional(),
  property: Joi.string().pattern(objectIdRegex).optional().allow('', null),
  unitId: Joi.string().pattern(objectIdRegex).optional().allow('', null),
  unit: Joi.string().max(100).optional(),
  payees: Joi.array().items(payeeSchema).min(1).optional(),
  
  // Expense Items - same as create but optional
  expenseItems: Joi.array().items(expenseItemSchema).min(1).optional(),
  
  // Additional fields - same as create but optional
  vendorPaidTo: Joi.string().max(200).optional().allow('', null),
  expenseDate: Joi.date().iso().optional(),
  dueDate: Joi.date().iso().optional(),
  paymentDate: Joi.date().iso().optional().allow(null),
  status: Joi.string().valid(...EXPENSE_STATUS_VALUES).optional()
}).min(1);

const listQuerySchema = Joi.object({
  property: Joi.string().pattern(objectIdRegex).optional(),
  landlordId: Joi.string().pattern(objectIdRegex).optional(),
  context: Joi.string().optional(),
  vendorPaidTo: Joi.string().optional().allow('', null),
  category: Joi.string().optional().allow('', null),
  payee: Joi.string().optional().allow('', null),
  status: Joi.string().valid(...EXPENSE_STATUS_VALUES).optional(),
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueStartDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueEndDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentStartDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentEndDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  unitId: Joi.string().pattern(objectIdRegex).optional(),
  unit: Joi.string().optional(),
  taxableEntity: Joi.string().optional(),
  bankAccount: Joi.string().optional(),
  minAmount: moneyAmountOptional({ min: 0 }),
  maxAmount: moneyAmountOptional({ min: 0 }),
  timePeriod: Joi.string().valid('month', 'quarter', 'half-year', 'year').optional(),
  search: Joi.string().optional().allow(''),
  pageNumber: Joi.number().integer().min(1).default(1),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
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

// POST /hoa/expense/:id/notes - "text" or "content" (at least one, non-empty after trim)
const addNoteSchema = Joi.object({
  text: Joi.string().trim().min(1).max(1000).optional(),
  content: Joi.string().trim().min(1).max(1000).optional()
})
  .or('text', 'content')
  .unknown(true);

module.exports = {
  idParamSchema,
  createExpenseSchema,
  updateExpenseSchema,
  listQuerySchema,
  addNoteSchema
};
