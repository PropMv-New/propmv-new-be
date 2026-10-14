/**
 * ------------------------------------------------------------------
 * File: expense.routes.js
 * Module: Expense Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../controller/expense.controller');
const { validateBody, validateQuery, validateParams } = require('../../../../middleware/requestValidator');
const { validateMultipart } = require('../../../../middleware/multipartValidator');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { idParamSchema, createExpenseSchema, updateExpenseSchema, listQuerySchema, exportQuerySchema, addNoteSchema, markPaidSchema } = require('../validators/expense.validator');
const expenseCategoryController = require('../controller/expenseCategory.controller');
const {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  idParamSchema: expenseCategoryIdSchema,
} = require('../validators/expenseCategory.validator');
const { multerInvoiceDocFilter } = require('../../../../common/helpers/fileValidationHelper');
const Joi = require('joi');
const logger = require('../../../../common/logger');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const customerParamSchema = Joi.object({ customerId: Joi.string().pattern(objectIdRegex).required() });

const expenseItemParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
  itemId: Joi.string().pattern(objectIdRegex).required()
});

const readGuard = [authMiddleware, authorize];
const writeGuard = [csrfProtection, authMiddleware, authorize];

// Create expense (multipart with optional files)
router.post('/', 
  ...writeGuard,
  controller.expenseUpload,
  validateMultipart(createExpenseSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.createExpense
);

// Get customers for the logged-in user (for Taxable Entity dropdown)
router.get('/customers', ...readGuard, controller.getCustomersForExpense);

// Get bank accounts for a specific customer (after selecting Taxable Entity)
router.get('/customers/:customerId/bank-accounts', ...readGuard, validateParams(customerParamSchema), controller.getBankAccountsForCustomer);

// Expense category routes (scoped custom categories in MasterData)
router.get('/categories', ...readGuard, expenseCategoryController.listExpenseCategories);
router.post('/categories', ...writeGuard, validateBody(createExpenseCategorySchema), expenseCategoryController.createExpenseCategory);
router.get('/categories/:id', ...readGuard, validateParams(expenseCategoryIdSchema), expenseCategoryController.getExpenseCategory);
router.patch('/categories/:id', ...writeGuard, validateParams(expenseCategoryIdSchema), validateBody(updateExpenseCategorySchema), expenseCategoryController.updateExpenseCategory);

// List expenses with new query parameters
router.get('/', ...readGuard, validateQuery(listQuerySchema), controller.listExpenses);

// Export expenses in multiple formats (CSV, Excel, JSON) - MUST be before /:id route
router.get('/export', ...readGuard, validateQuery(exportQuerySchema), controller.exportExpenses);

// Get expense by id
router.get('/:id', ...readGuard, validateParams(idParamSchema), controller.getExpense);

// Update expense (multipart with optional files)
router.put('/:id', 
  ...writeGuard,
  validateParams(idParamSchema), 
  controller.expenseUpload,
  validateMultipart(updateExpenseSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.updateExpense
);

// Delete expense (soft-delete)
router.delete('/:id', ...writeGuard, validateParams(idParamSchema), controller.deleteExpense);

// Upload document for specific expense item
const { createUpload } = require('../../../../common/helpers/uploadHelper');
const { uploadSingle: singleDocUpload } = createUpload('document', 'expense-receipts', {
  maxCount: 1,
  fileFilter: multerInvoiceDocFilter,
  maxSizeBytes: 50 * 1024 * 1024
});

router.post('/:id/items/:itemId/document', 
  ...writeGuard,
  validateParams(expenseItemParamSchema),
  (req, res, next) => {
    singleDocUpload(req, res, (err) => {
      if (err) {
        logger.error('Multer error:', err);
        return res.status(400).json({ message: err.message || 'File upload failed' });
      }
      next();
    });
  },
  validateMultipart(null, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC' }),
  controller.uploadExpenseItemDocument
);

router.post('/:id/notes', 
  ...writeGuard,
  validateParams(idParamSchema),
  validateBody(addNoteSchema),
  controller.addNote
);

// Mark expense as paid
router.patch('/:id/mark-paid', 
  ...writeGuard,
  validateParams(idParamSchema),
  validateBody(markPaidSchema),
  controller.markAsPaid
);

module.exports = router;
