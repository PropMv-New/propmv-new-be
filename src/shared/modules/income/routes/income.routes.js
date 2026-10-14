/**
 * ------------------------------------------------------------------
 * File: income.routes.js
 * Module: Income Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * routes
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../controller/income.controller');
const validator = require('../validators/income.validator');
const authenticate = require('../../../../middleware/auth');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { validationResult } = require('express-validator');

// Middleware to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

const readGuard = [authenticate];
const writeGuard = [csrfProtection, authenticate];

// Create income
router.post('/', 
  ...writeGuard, 
  validator.createIncomeValidator, 
  handleValidationErrors, 
  controller.createIncome
);

// Get all incomes with filters
router.get('/', 
  ...readGuard, 
  validator.getIncomesValidator, 
  handleValidationErrors, 
  controller.getIncomes
);

// Get income by ID
router.get('/:id', 
  ...readGuard, 
  validator.getIncomeByIdValidator, 
  handleValidationErrors, 
  controller.getIncomeById
);

// Update income
router.put('/:id', 
  ...writeGuard, 
  validator.updateIncomeValidator, 
  handleValidationErrors, 
  controller.updateIncome
);

// Delete income
router.delete('/:id', 
  ...writeGuard, 
  validator.deleteIncomeValidator, 
  handleValidationErrors, 
  controller.deleteIncome
);

module.exports = router;