/**
 * ------------------------------------------------------------------
 * File: ledger.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * owner.routes
 * ------------------------------------------------------------------
 */

const ledgerService = require('../services/ledger.service');
const Invoice = require('../../invoice/model/invoice.model');
const responseHelper = require('../../../../../common/helpers/responseHelper');

/**
 * POST /units/:id/adjustment
 * Body: { amount: number, reason: string }
 */
const applyAdjustment = async (req, res) => {
  try {
    const unitId = req.params.id;
    const { amount, reason, paymentMethod, dueDate, checkNumber, moneyOrderNumber } = req.body;

    if (amount === undefined || amount === null) {
      return responseHelper.error(res, 'amount is required', 400);
    }
    const parsedAmount = Number(amount);
    if (!isFinite(parsedAmount)) {
      return responseHelper.error(res, 'amount must be a valid number', 400);
    }
    if (!reason || !String(reason).trim()) {
      return responseHelper.error(res, 'reason is required', 400);
    }

    const createdBy = req.user?._id || null;
    const entry = await ledgerService.applyBalanceAdjustment(unitId, parsedAmount, reason, createdBy, dueDate, paymentMethod, checkNumber, moneyOrderNumber);
    const summary = await ledgerService.getBalanceSummary(unitId);
    return responseHelper.success(res, { entry, summary }, 'Adjustment applied successfully', 201);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

/**
 * GET /units/:id/balance
 */
const getBalance = async (req, res) => {
  try {
    const unitId = req.params.id;
    const readOnly = req.query.readOnly === 'true' || req.query.readOnly === '1';
    const summary = await ledgerService.getBalanceSummary(unitId, { readOnly });
    return responseHelper.success(res, summary, 'Balance retrieved successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

/**
 * POST /units/balances
 * Body: { unitIds: string[] }
 */
const getBalancesBatch = async (req, res) => {
  try {
    const unitIds = Array.isArray(req.body?.unitIds) ? req.body.unitIds : [];
    const summaries = await ledgerService.getBalanceSummariesBatch(unitIds, { readOnly: true });
    return responseHelper.success(res, { summaries }, 'Balances retrieved successfully', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

/**
 * GET /units/:id/ledger
 * Full audit trail of ledger entries.
 */
const getLedger = async (req, res) => {
  try {
    const unitId = req.params.id;
    const entries = await ledgerService.getLedgerEntries(unitId);
    return responseHelper.success(res, { entries }, 'Ledger entries retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

/**
 * GET /units/:id/ledger/invoice/:invoiceId
 * Ledger entries linked to a specific invoice.
 */
const getLedgerByInvoice = async (req, res) => {
  try {
    const { id: unitId, invoiceId } = req.params;
    const LedgerEntry = require('../models/ledgerEntry.model');
    const mongoose = require('mongoose');
    const invoiceObjectId = new mongoose.Types.ObjectId(invoiceId);
    const entries = await LedgerEntry.find({
      unitId: new mongoose.Types.ObjectId(unitId),
      $or: [
        { referenceId: invoiceObjectId },
        { 'metadata.appliedInvoices.invoiceId': invoiceObjectId },
      ],
    }).sort({ createdAt: 1 }).lean();
    return responseHelper.success(res, { entries }, 'Ledger entries retrieved', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 500);
  }
};

module.exports = { applyAdjustment, getBalance, getBalancesBatch, getLedger, getLedgerByInvoice };
