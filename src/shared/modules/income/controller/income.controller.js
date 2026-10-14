/**
 * ------------------------------------------------------------------
 * File: income.controller.js
 * Module: Income Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * income.routes
 * ------------------------------------------------------------------
 */

const service = require('../service/income.service');
const { resolveCreatedBy } = require('../../../../shared/utils/creatorScope.util');

const createIncome = async (req, res, next) => {
  try {
    const result = await service.createIncome(req.body, req.userId);
    return res.status(201).json(result);
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation failed', errors: err.errors });
    }
    if (err && err.status) {
      return res.status(err.status).json({ message: err.message });
    }
    next(err);
  }
};

const getIncomes = async (req, res, next) => {
  try {
    const actorId = req.userId || (req.user && (req.user._id || req.user.id));
    const isAdmin = req.user && req.user.isAdministrator;
    const companyId = req.user && req.user.companyId;

    const createdByValue = isAdmin
      ? { userId: actorId, isAdministrator: true, companyId }
      : resolveCreatedBy(req.query || {}, actorId);

    const result = await service.getIncomes(Object.assign({}, req.query || {}, {
      createdBy: createdByValue,
    }));
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};

const getIncomeById = async (req, res, next) => {
  try {
    const income = await service.getIncomeById(req.params.id);
    return res.status(200).json(income);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const updateIncome = async (req, res, next) => {
  try {
    const updated = await service.updateIncome(req.params.id, req.body, req.userId);
    return res.status(200).json(updated);
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation failed', errors: err.errors });
    }
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

const deleteIncome = async (req, res, next) => {
  try {
    await service.deleteIncome(req.params.id);
    return res.status(200).json({ message: 'Income deleted' });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

module.exports = {
  createIncome,
  getIncomes,
  getIncomeById,
  updateIncome,
  deleteIncome
};
