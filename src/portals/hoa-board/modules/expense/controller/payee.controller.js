/**
 * ------------------------------------------------------------------
 * File: payee.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * expense.routes, payee.routes
 * ------------------------------------------------------------------
 */

const responseHelper = require('../../../../../common/helpers/responseHelper');
const payeeService = require('../service/payee.service');

async function createPayee(req, res) {
  try {
    const userId = req.userId || (req.user && (req.user._id || req.user.id));
    const payee = await payeeService.createPayee(req.body, userId, req.hoaContext || null);
    return responseHelper.success(res, { payee }, 'Payee created', 201);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to create payee', status);
  }
}

async function listPayees(req, res) {
  try {
    const result = await payeeService.listPayees(req.query, req.hoaContext || null);
    return responseHelper.success(res, result, 'Payees fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to list payees', status);
  }
}

async function getPayee(req, res) {
  try {
    const payee = await payeeService.getPayeeById(req.params.id);
    return responseHelper.success(res, { payee }, 'Payee fetched', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to fetch payee', status);
  }
}

async function updatePayee(req, res) {
  try {
    const userId = req.userId || (req.user && (req.user._id || req.user.id));
    const payee = await payeeService.updatePayee(req.params.id, req.body, userId);
    return responseHelper.success(res, { payee }, 'Payee updated', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to update payee', status);
  }
}

async function deletePayee(req, res) {
  try {
    const userId = req.userId || (req.user && (req.user._id || req.user.id));
    await payeeService.deletePayee(req.params.id, userId);
    return responseHelper.success(res, null, 'Payee deleted', 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return responseHelper.error(res, err.message || 'Failed to delete payee', status);
  }
}

module.exports = {
  createPayee,
  listPayees,
  getPayee,
  updatePayee,
  deletePayee
};
