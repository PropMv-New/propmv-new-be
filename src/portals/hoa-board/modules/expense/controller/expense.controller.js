/**
 * ------------------------------------------------------------------
 * File: expense.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * expense.routes
 * ------------------------------------------------------------------
 */

const responseHelper = require('../../../../../common/helpers/responseHelper');
const expenseService = require('../service/expense.service');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { multerInvoiceDocFilter } = require('../../../../../common/helpers/fileValidationHelper');
const { getProfile } = require('../../../../../common/constants/uploadFileTypes');
const { HOA_DOCUMENT_MAX_TOTAL_BYTES } = require('../../../../../shared/modules/documents/helpers/hoaDocumentUploadLimits');

const hoaDocumentUploadMaxBytes = Math.min(
  getProfile('INVOICE_DOC').maxSizeBytes,
  HOA_DOCUMENT_MAX_TOTAL_BYTES,
);

// Multer middleware for expense item documents
const { uploadArray: expenseUpload } = createUpload('documents', 'expense-receipts', {
  maxCount: 10, // Allow multiple files for different expense items
  fileFilter: multerInvoiceDocFilter,
  maxSizeBytes: hoaDocumentUploadMaxBytes,
});

async function createExpense(req, res) {
  logControllerStep(req, 'START', { action: 'createExpense' });
  try {
    // Data is already parsed and validated by validateMultipart middleware
    const payload = req.body;
    const userId = req.user && (req.user._id || req.user.id);
    const files = req.files || [];
    
    const created = await expenseService.createExpense(payload, {
      userId,
      files,
      userContext: req.hoaContext || null,
    });
    return responseHelper.success(res, { expense: created }, 'Expense created', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to create expense', status);
  }
}

async function listExpenses(req, res) {
  logControllerStep(req, 'START', { action: 'listExpenses' });
  try {
    const rawPageNumber = typeof req.query.pageNumber !== 'undefined' ? req.query.pageNumber : req.query.page;
    const rawPageSize = req.query.pageSize;
    const parsedPageNumber = rawPageNumber ? parseInt(rawPageNumber, 10) : undefined;
    const parsedPageSize = rawPageSize ? parseInt(rawPageSize, 10) : undefined;

    const safeQuery = {
      pageNumber: parsedPageNumber,
      pageSize: parsedPageSize,
      search: req.query.search ? String(req.query.search).trim() : undefined,
      status: req.query.status ? String(req.query.status).trim() : undefined,
      category: req.query.category ? String(req.query.category).trim() : undefined,
      startDate: req.query.startDate ? String(req.query.startDate).trim() : undefined,
      endDate: req.query.endDate ? String(req.query.endDate).trim() : undefined,
      property: (req.query.property || req.query.propertyId) ? String(req.query.property || req.query.propertyId).trim() : undefined,
      unit: req.query.unit ? String(req.query.unit).trim() : undefined,
      unitId: req.query.unitId ? String(req.query.unitId).trim() : undefined,
      payee: req.query.payee ? String(req.query.payee).trim() : undefined,
      bankAccount: req.query.bankAccount ? String(req.query.bankAccount).trim() : undefined,
      taxableEntity: req.query.taxableEntity ? String(req.query.taxableEntity).trim() : undefined,
      sortBy: req.query.sortBy ? String(req.query.sortBy).trim() : undefined,
      sortOrder: req.query.sortOrder ? String(req.query.sortOrder).trim() : undefined,
    };

    const result = await expenseService.listExpenses(
      safeQuery,
      req.hoaContext || null
    );
    return responseHelper.success(res, result, 'Expenses fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to list expenses', status);
  }
}

async function getExpense(req, res) {
  logControllerStep(req, 'START', { action: 'getExpense' });
  try {
    const id = req.params.id;
    const item = await expenseService.getExpenseById(id, { hoaContext: req.hoaContext });
    return responseHelper.success(res, { expense: item }, 'Expense fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to fetch expense', status);
  }
}

async function updateExpense(req, res) {
  logControllerStep(req, 'START', { action: 'updateExpense' });
  try {
    const id = req.params.id;
    // Data is already parsed and validated by validateMultipart middleware
    const payload = req.body;
    const files = req.files || [];
    
    const updated = await expenseService.updateExpense(id, payload, {
      files,
      uploadedBy: req.user._id,
      userContext: req.hoaContext || null,
    });
    return responseHelper.success(res, { expense: updated }, 'Expense updated', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to update expense', status);
  }
}

async function deleteExpense(req, res) {
  logControllerStep(req, 'START', { action: 'deleteExpense' });
  try {
    const id = req.params.id;
    const userId = req.user?._id || req.user?.id;
    await expenseService.deleteExpense(id, { userId });
    return responseHelper.success(res, null, 'Expense deleted', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to delete expense', status);
  }
}

async function addNote(req, res) {
  logControllerStep(req, 'START', { action: 'addNote' });
  try {
    const text =
      req.body.text != null && String(req.body.text).trim() !== ''
        ? String(req.body.text).trim()
        : req.body.content != null
          ? String(req.body.content).trim()
          : '';
    const userId = req.user && (req.user._id || req.user.id);
    const updated = await expenseService.addNote(req.params.id, text, {
      userId,
      hoaContext: req.hoaContext || null,
    });
    return responseHelper.success(res, { expense: updated }, 'Note added', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to add note', status);
  }
}

async function markAsPaid(req, res) {
  logControllerStep(req, 'START', { action: 'markAsPaid' });
  try {
    const id = req.params.id;
    const comment = req.body && typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
    const userId = req.user && (req.user._id || req.user.id);
    const updated = await expenseService.markAsPaid(id, { comment, userId });
    return responseHelper.success(res, { expense: updated }, 'Expense marked as paid', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to mark expense as paid', status);
  }
}

// Upload document for specific expense item
async function uploadExpenseItemDocument(req, res) {
  logControllerStep(req, 'START', { action: 'uploadExpenseItemDocument' });
  try {
    const expenseId = req.params.id;
    const itemId = req.params.itemId;
    const userId = req.user && (req.user._id || req.user.id);
    
    if (!req.files || !req.files.length) {
      return responseHelper.error(res, 'No files uploaded', 400);
    }

    const updated = await expenseService.uploadExpenseItemDocument(expenseId, itemId, req.files, { uploadedBy: userId });
    return responseHelper.success(res, { expense: updated }, 'Document uploaded', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to upload document', status);
  }
}

module.exports = {
  createExpense,
  listExpenses,
  getExpense,
  updateExpense,
  deleteExpense,
  uploadExpenseItemDocument,
  addNote,
  markAsPaid,
  expenseUpload
};
