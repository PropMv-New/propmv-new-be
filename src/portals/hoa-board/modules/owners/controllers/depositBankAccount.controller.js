/**
 * ------------------------------------------------------------------
 * File: depositBankAccount.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * owner.routes
 * ------------------------------------------------------------------
 */

const depositBankAccountService = require('../services/depositBankAccount.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');

const getUsage = async (req, res, next) => {
  try {
    const { bankAccountId } = req.params;
    const usage = await depositBankAccountService.getDepositBankAccountUsage(
      bankAccountId,
      req.hoaContext || null
    );
    return responseHelper.success(res, usage, 'Deposit bank account usage retrieved');
  } catch (err) {
    return next(err);
  }
};

const reassign = async (req, res, next) => {
  try {
    const { fromBankAccountId, toBankAccountId, toBankAccountName } = req.body;
    const result = await depositBankAccountService.reassignDepositBankAccount(
      fromBankAccountId,
      toBankAccountId,
      toBankAccountName,
      req.hoaContext || null,
      req.userId || req.user?._id
    );
    return responseHelper.success(res, result, 'Deposit bank account reassigned successfully');
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getUsage,
  reassign,
};
