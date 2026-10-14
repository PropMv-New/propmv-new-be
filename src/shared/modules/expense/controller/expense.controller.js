/**
 * ------------------------------------------------------------------
 * File: expense.controller.js
 * Module: Expense Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * expense.routes
 * ------------------------------------------------------------------
 */

const responseHelper = require('../../../../common/helpers/responseHelper');

const expenseService = require('../service/expense.service');

const expenseExportService = require('../service/expenseExport.service');

const { createUpload } = require('../../../../common/helpers/uploadHelper');

const { multerInvoiceDocFilter } = require('../../../../common/helpers/fileValidationHelper');

const PaymentCustomer = require('../../payment/model/paymentCustomer.model');

const PaymentBankAccount = require('../../payment/model/paymentBankAccount.model');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');



const { uploadArray: expenseUpload } = createUpload('documents', 'expense-receipts', {

  maxCount: 10,

  fileFilter: multerInvoiceDocFilter,

  maxSizeBytes: 50 * 1024 * 1024,

});



/**
 * get Actor Id
 *
 * Performs logic operations for getActorId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getActorId(req) {

  return req.userId || (req.user && (req.user._id || req.user.id)) || null;

}



/**
 * handle Service Error
 *
 * Performs logic operations for handleServiceError.
 *
 * @param res - Request/input argument
 * @param err - Request/input argument
 * @param fallbackMessage - Request/input argument
 * @returns Operations result
 */
function handleServiceError(res, err, fallbackMessage) {

  const status = err && err.status ? err.status : 500;

  return responseHelper.error(res, err.message || fallbackMessage, status);

}



async function createExpense(req, res) {
  logControllerStep(req, 'START', { action: 'createExpense' });

  try {

    const { itemIndices: itemIndicesRaw, ...data } = req.body || {};

    const files = (req.files || []).filter((f) => f && (f.size || 0) > 0 && f.path);

    const created = await expenseService.createExpense(data, {

      userId: getActorId(req),

      files,

      itemIndices: expenseService.parseExpenseItemIndices(itemIndicesRaw),

    });

    return responseHelper.success(res, { expense: created }, 'Expense created', 201);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to create expense');

  }

}



async function listExpenses(req, res) {
  logControllerStep(req, 'START', { action: 'listExpenses' });

  try {

    const actorId = getActorId(req);
    const isAdmin = req.user && req.user.isAdministrator;
    const companyId = req.user && req.user.companyId;

    const queryPayload = Object.assign({}, req.query || {});
    queryPayload.createdBy = isAdmin
      ? { userId: actorId, isAdministrator: true, companyId }
      : expenseService.mergeExpenseScopeFromActor(req.query || {}, actorId).createdBy;

    const result = await expenseService.listExpenses(
      expenseService.normalizeListQuery(queryPayload || {}, actorId)
    );

    return responseHelper.success(res, result, 'Expenses fetched', 200);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to list expenses');

  }

}



async function getExpense(req, res) {
  logControllerStep(req, 'START', { action: 'getExpense' });

  try {

    const item = await expenseService.getExpenseById(req.params.id);

    return responseHelper.success(res, { expense: item }, 'Expense fetched', 200);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to fetch expense');

  }

}



async function updateExpense(req, res) {
  logControllerStep(req, 'START', { action: 'updateExpense' });

  try {

    const { itemIndices: itemIndicesRaw, ...updates } = req.body || {};

    const userId = getActorId(req);

    const files = (req.files || []).filter((f) => f && (f.size || 0) > 0 && f.path);

    const updated = await expenseService.updateExpense(req.params.id, updates, {

      files,

      uploadedBy: userId,

      itemIndices: expenseService.parseExpenseItemIndices(itemIndicesRaw),

    });

    return responseHelper.success(res, { expense: updated }, 'Expense updated', 200);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to update expense');

  }

}



async function deleteExpense(req, res) {
  logControllerStep(req, 'START', { action: 'deleteExpense' });

  try {

    await expenseService.deleteExpense(req.params.id);

    return responseHelper.success(res, null, 'Expense deleted', 200);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to delete expense');

  }

}



async function uploadExpenseItemDocument(req, res) {
  logControllerStep(req, 'START', { action: 'uploadExpenseItemDocument' });

  try {

    const file = req.file || (req.files && req.files[0]);

    if (!file) {

      return responseHelper.error(res, 'No file uploaded', 400);

    }



    const updated = await expenseService.uploadExpenseItemDocument(

      req.params.id,

      req.params.itemId,

      [file],

      { uploadedBy: getActorId(req) }

    );

    return responseHelper.success(res, { expense: updated }, 'Document uploaded', 201);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to upload document');

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

    const updated = await expenseService.addNote(req.params.id, text, getActorId(req));

    return responseHelper.success(res, { expense: updated }, 'Note added', 201);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to add note');

  }

}



async function markAsPaid(req, res) {
  logControllerStep(req, 'START', { action: 'markAsPaid' });

  try {

    const comment = req.body && typeof req.body.comment === 'string' ? req.body.comment.trim() : '';

    const updated = await expenseService.markAsPaid(req.params.id, {

      comment,

      userId: getActorId(req),

    });

    return responseHelper.success(res, { expense: updated }, 'Expense marked as paid', 200);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to mark expense as paid');

  }

}



async function exportExpenses(req, res) {
  logControllerStep(req, 'START', { action: 'exportExpenses' });

  try {

    const actorId = getActorId(req);
    const isAdmin = req.user && req.user.isAdministrator;
    const companyId = req.user && req.user.companyId;

    const q = Object.assign({}, req.query || {});
    q.createdBy = isAdmin ? { userId: actorId, isAdministrator: true, companyId } : expenseService.mergeExpenseScopeFromActor(req.query || {}, actorId).createdBy;

    const format = q.format || 'csv';

    delete q.format;



    const result = await expenseExportService.exportExpenses(q, format);

    const filename = result && result.filename ? result.filename : `expenses_export.${format}`;

    const content = result && result.content ? result.content : '';

    const contentType = result && result.contentType ? result.contentType : 'application/octet-stream';



    res.setHeader('Content-Type', contentType);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(content);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to export expenses');

  }

}



async function getCustomersForExpense(req, res) {
  logControllerStep(req, 'START', { action: 'getCustomersForExpense' });

  try {

    const userId = getActorId(req);

    const customers = await PaymentCustomer.find({ createdBy: userId }).select('_id name email').sort({ name: 1 }).lean();

    return responseHelper.success(res, { customers }, 'Customers fetched', 200);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to fetch customers');

  }

}



async function getBankAccountsForCustomer(req, res) {
  logControllerStep(req, 'START', { action: 'getBankAccountsForCustomer' });

  try {

    const userId = getActorId(req);

    const { customerId } = req.params;

    const customer = await PaymentCustomer.findOne({ _id: customerId, createdBy: userId }).lean();

    if (!customer) return responseHelper.error(res, 'Customer not found', 404);

    const accounts = await PaymentBankAccount.find({ paymentCustomerId: customerId }).select('_id holderName accountType last4 verificationStatus').sort({ createdAt: -1 }).lean();

    return responseHelper.success(res, { bankAccounts: accounts }, 'Bank accounts fetched', 200);

  } catch (err) {

    return handleServiceError(res, err, 'Failed to fetch bank accounts');

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

  exportExpenses,

  expenseUpload,

  getCustomersForExpense,

  getBankAccountsForCustomer,

};

