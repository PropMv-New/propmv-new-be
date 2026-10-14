const Joi = require('joi');
const { VENDOR_INVOICE_STATUS } = require('../model/vendorInvoice.model');
const { moneyAmount, moneyAmountOptional, quantityAmount } = require('../../../../../common/validators/money.schema');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const statusValues = Object.values(VENDOR_INVOICE_STATUS);

const idParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
});

const lineItemSchema = Joi.object({
  description: Joi.string().trim().min(1).max(500).required(),
  quantity: quantityAmount({ min: 0, required: false }).default(1),
  rate: moneyAmount({ min: 0 }),
  amount: moneyAmountOptional({ min: 0 }),
});

const createVendorInvoiceSchema = Joi.object({
  assignedTo: Joi.string().pattern(objectIdRegex).required(),
  title: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().trim().max(5000).allow('').optional(),
  lineItems: Joi.array().items(lineItemSchema).min(1).required(),
  dueDate: Joi.date().iso().optional().allow(null, ''),
  notes: Joi.string().trim().max(2000).allow('').optional(),
  maintenanceRequestId: Joi.string().pattern(objectIdRegex).optional().allow(null, ''),
  hoaId: Joi.string().pattern(objectIdRegex).optional(),
  amountPaid: moneyAmountOptional({ min: 0 }),
});

const updateVendorInvoiceSchema = Joi.object({
  assignedTo: Joi.string().pattern(objectIdRegex).optional(),
  title: Joi.string().trim().min(1).max(200).optional(),
  description: Joi.string().trim().max(5000).allow('').optional(),
  lineItems: Joi.array().items(lineItemSchema).min(1).optional(),
  dueDate: Joi.date().iso().optional().allow(null, ''),
  notes: Joi.string().trim().max(2000).allow('').optional(),
  status: Joi.string().valid(...statusValues).optional(),
  amountPaid: moneyAmountOptional({ min: 0 }),
  maintenanceRequestId: Joi.string().pattern(objectIdRegex).optional().allow(null, ''),
  // Optional payment metadata used when creating the linked expense on Paid
  paymentMethod: Joi.string().trim().max(120).optional().allow(''),
  paymentDate: Joi.alternatives().try(Joi.date().iso(), Joi.string().trim()).optional().allow(null, ''),
  bankAccount: Joi.string().trim().max(200).optional().allow(''),
}).min(1);

const listQuerySchema = Joi.object({
  status: Joi.string().valid(...statusValues).optional(),
  assignedTo: Joi.string().pattern(objectIdRegex).optional(),
  vendorId: Joi.string().pattern(objectIdRegex).optional(),
  searchText: Joi.string().trim().max(200).optional(),
  pageNumber: Joi.number().integer().min(1).default(1),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Comma-separated payment method values (ACH, Card, Cash, Check, Money Order). */
  paymentMethod: Joi.string().trim().max(200).optional().allow(''),
});

const noteIdParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
  noteId: Joi.string().pattern(objectIdRegex).required(),
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
}).unknown(true);

module.exports = {
  idParamSchema,
  createVendorInvoiceSchema,
  updateVendorInvoiceSchema,
  listQuerySchema,
  noteIdParamSchema,
  entityNotePayloadSchema,
  updateEntityNoteSchema,
  VENDOR_INVOICE_STATUS: statusValues,
};
