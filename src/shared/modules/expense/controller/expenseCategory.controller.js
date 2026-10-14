'use strict';

const responseHelper = require('../../../../common/helpers/responseHelper');
const expenseCategoryService = require('../service/expenseCategory.service');

function resolveUserId(req) {
  return req.userId || (req.user && (req.user._id || req.user.id));
}

async function listExpenseCategories(req, res) {
  try {
    const userId = resolveUserId(req);
    const result = await expenseCategoryService.listExpenseCategories(req.hoaContext || null, userId);
    return responseHelper.success(res, result, 'Expense categories fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to list expense categories', status);
  }
}

async function createExpenseCategory(req, res) {
  try {
    const userId = resolveUserId(req);
    const category = await expenseCategoryService.createExpenseCategory(req.body, userId, req.hoaContext || null);
    return responseHelper.success(res, { category }, 'Expense category created', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to create expense category', status);
  }
}

async function getExpenseCategory(req, res) {
  try {
    const userId = resolveUserId(req);
    const category = await expenseCategoryService.getExpenseCategoryById(req.params.id, req.hoaContext || null, userId);
    return responseHelper.success(res, { category }, 'Expense category fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to fetch expense category', status);
  }
}

async function updateExpenseCategory(req, res) {
  try {
    const userId = resolveUserId(req);
    const category = await expenseCategoryService.updateExpenseCategory(
      req.params.id,
      req.body,
      userId,
      req.hoaContext || null,
    );
    return responseHelper.success(res, { category }, 'Expense category updated', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to update expense category', status);
  }
}

module.exports = {
  listExpenseCategories,
  createExpenseCategory,
  getExpenseCategory,
  updateExpenseCategory,
};
