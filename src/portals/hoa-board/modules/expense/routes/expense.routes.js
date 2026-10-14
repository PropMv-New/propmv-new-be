/**
 * ------------------------------------------------------------------
 * File: expense.routes.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../controller/expense.controller');
const payeeController = require('../controller/payee.controller');
const { validateBody, validateQuery, validateParams } = require('../../../../../common/middleware/requestValidator');
const { validateMultipart } = require('../../../../../common/middleware/multipartValidator');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const { idParamSchema, createExpenseSchema, updateExpenseSchema, listQuerySchema, addNoteSchema } = require('../validators/expense.validator');
const { idParamSchema: payeeIdSchema, createPayeeSchema, updatePayeeSchema, listQuerySchema: payeeListSchema } = require('../validators/payee.validator');
const expenseCategoryController = require('../../../../../shared/modules/expense/controller/expenseCategory.controller');
const {
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  idParamSchema: expenseCategoryIdSchema,
} = require('../../../../../shared/modules/expense/validators/expenseCategory.validator');
const { multerInvoiceDocFilter } = require('../../../../../common/helpers/fileValidationHelper');
const Joi = require('joi');

const markPaidSchema = Joi.object({
  comment: Joi.string().trim().max(1000).optional().allow('', null)
});

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const expenseItemParamSchema = Joi.object({
  id: Joi.string().pattern(objectIdRegex).required(),
  itemId: Joi.string().pattern(objectIdRegex).required()
});

// Payee routes (must come before /:id routes)
router.post('/payees', authMiddleware, csrfProtection, authorize, validateBody(createPayeeSchema), payeeController.createPayee);
router.get('/payees', authMiddleware, authorize, validateQuery(payeeListSchema), payeeController.listPayees);
router.get('/payees/:id', authMiddleware, authorize, validateParams(payeeIdSchema), payeeController.getPayee);
router.put('/payees/:id', authMiddleware, csrfProtection, authorize, validateParams(payeeIdSchema), validateBody(updatePayeeSchema), payeeController.updatePayee);
router.delete('/payees/:id', authMiddleware, csrfProtection, authorize, validateParams(payeeIdSchema), payeeController.deletePayee);

// Expense category routes (scoped custom categories in MasterData)
router.get('/categories', authMiddleware, authorize, expenseCategoryController.listExpenseCategories);
router.post('/categories', authMiddleware, csrfProtection, authorize, validateBody(createExpenseCategorySchema), expenseCategoryController.createExpenseCategory);
router.get('/categories/:id', authMiddleware, authorize, validateParams(expenseCategoryIdSchema), expenseCategoryController.getExpenseCategory);
router.patch('/categories/:id', authMiddleware, csrfProtection, authorize, validateParams(expenseCategoryIdSchema), validateBody(updateExpenseCategorySchema), expenseCategoryController.updateExpenseCategory);

// Create expense (multipart with optional files)
router.post('/', 
  authMiddleware,
  csrfProtection,
  authorize, 
  controller.expenseUpload, // multer middleware
  validateMultipart(createExpenseSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.createExpense
);

// List expenses with new query parameters
router.get('/', authMiddleware, authorize, validateQuery(listQuerySchema), controller.listExpenses);

// Get expense by id
router.get('/:id', authMiddleware, authorize, validateParams(idParamSchema), controller.getExpense);

// Update expense (multipart with optional files)
router.put('/:id', 
  authMiddleware,
  csrfProtection,
  authorize, 
  validateParams(idParamSchema), 
  controller.expenseUpload, // multer middleware
  validateMultipart(updateExpenseSchema, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', parseJsonData: true }),
  controller.updateExpense
);

// Delete expense (soft-delete)
router.delete('/:id', authMiddleware, csrfProtection, authorize, validateParams(idParamSchema), controller.deleteExpense);

// Add note to expense
router.post('/:id/notes',
  authMiddleware,
  csrfProtection,
  authorize,
  validateParams(idParamSchema),
  validateBody(addNoteSchema),
  controller.addNote
);

// Mark expense as paid
router.patch('/:id/mark-paid',
  authMiddleware,
  csrfProtection,
  authorize,
  validateParams(idParamSchema),
  validateBody(markPaidSchema),
  controller.markAsPaid
);

// Upload document for specific expense item
router.post('/:id/items/:itemId/document', 
  authMiddleware,
  csrfProtection,
  authorize, 
  validateParams(expenseItemParamSchema),
  controller.expenseUpload, // multer middleware
  validateMultipart(null, { fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC' }),
  controller.uploadExpenseItemDocument
);

module.exports = router;
