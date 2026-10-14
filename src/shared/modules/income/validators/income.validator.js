/**
 * ------------------------------------------------------------------
 * File: income.validator.js
 * Module: Income Module
 *
 * Purpose:
 * Joi or OpenAPI validator schema for request body, parameters, and query options.
 *
 * Used By:
 * income.routes
 * ------------------------------------------------------------------
 */

const { body, param, query } = require('express-validator');

const createIncomeValidator = [
  body('type')
    .isIn(['Rent', 'Deposit', 'Late Fee', 'Pet Fee', 'Parking Fee', 'Other'])
    .withMessage('Type must be one of: Rent, Deposit, Late Fee, Pet Fee, Parking Fee, Other'),
  body('propertyId')
    .isMongoId()
    .withMessage('Property ID must be a valid MongoDB ObjectId'),
  body('unit')
    .notEmpty()
    .withMessage('Unit is required'),
  body('tenants')
    .isArray({ min: 1 })
    .withMessage('At least one tenant is required')
    .custom((tenants) => {
      return tenants.every(tenant => /^[0-9a-fA-F]{24}$/.test(tenant));
    })
    .withMessage('All tenant IDs must be valid MongoDB ObjectIds'),
  body('amount')
    .isFloat({ min: 0 })
    .withMessage('Amount must be a positive number'),
  body('description')
    .notEmpty()
    .withMessage('Description is required'),
  body('dueDate')
    .isISO8601()
    .withMessage('Due date must be a valid ISO 8601 date'),
  body('receivedDate')
    .optional()
    .isISO8601()
    .withMessage('Received date must be a valid ISO 8601 date'),
  body('status')
    .optional()
    .isIn(['Pending', 'Received', 'Overdue'])
    .withMessage('Status must be one of: Pending, Received, Overdue'),
  body('paymentMethod')
    .optional()
    .isString()
    .withMessage('Payment method must be a string'),
  body('notes')
    .optional()
    .isString()
    .withMessage('Notes must be a string')
];

const updateIncomeValidator = [
  param('id')
    .isMongoId()
    .withMessage('Income ID must be a valid MongoDB ObjectId'),
  body('type')
    .optional()
    .isIn(['Rent', 'Deposit', 'Late Fee', 'Pet Fee', 'Parking Fee', 'Other'])
    .withMessage('Type must be one of: Rent, Deposit, Late Fee, Pet Fee, Parking Fee, Other'),
  body('propertyId')
    .optional()
    .isMongoId()
    .withMessage('Property ID must be a valid MongoDB ObjectId'),
  body('unit')
    .optional()
    .notEmpty()
    .withMessage('Unit cannot be empty'),
  body('tenants')
    .optional()
    .isArray({ min: 1 })
    .withMessage('At least one tenant is required')
    .custom((tenants) => {
      return tenants.every(tenant => /^[0-9a-fA-F]{24}$/.test(tenant));
    })
    .withMessage('All tenant IDs must be valid MongoDB ObjectIds'),
  body('amount')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Amount must be a positive number'),
  body('description')
    .optional()
    .notEmpty()
    .withMessage('Description cannot be empty'),
  body('dueDate')
    .optional()
    .isISO8601()
    .withMessage('Due date must be a valid ISO 8601 date'),
  body('receivedDate')
    .optional()
    .isISO8601()
    .withMessage('Received date must be a valid ISO 8601 date'),
  body('status')
    .optional()
    .isIn(['Pending', 'Received', 'Overdue'])
    .withMessage('Status must be one of: Pending, Received, Overdue'),
  body('paymentMethod')
    .optional()
    .isString()
    .withMessage('Payment method must be a string'),
  body('notes')
    .optional()
    .isString()
    .withMessage('Notes must be a string')
];

const getIncomeByIdValidator = [
  param('id')
    .isMongoId()
    .withMessage('Income ID must be a valid MongoDB ObjectId')
];

const deleteIncomeValidator = [
  param('id')
    .isMongoId()
    .withMessage('Income ID must be a valid MongoDB ObjectId')
];

const getIncomesValidator = [
  query('propertyId')
    .optional()
    .isMongoId()
    .withMessage('Property ID must be a valid MongoDB ObjectId'),
  query('createdBy')
    .optional()
    .isMongoId()
    .withMessage('createdBy must be a valid MongoDB ObjectId'),
  query('tenantId')
    .optional()
    .isMongoId()
    .withMessage('Tenant ID must be a valid MongoDB ObjectId'),
  query('type')
    .optional()
    .isIn(['Rent', 'Deposit', 'Late Fee', 'Pet Fee', 'Parking Fee', 'Other'])
    .withMessage('Type must be one of: Rent, Deposit, Late Fee, Pet Fee, Parking Fee, Other'),
  query('status')
    .optional()
    .isIn(['Pending', 'Received', 'Overdue'])
    .withMessage('Status must be one of: Pending, Received, Overdue'),
  query('startDate')
    .optional()
    .isISO8601()
    .withMessage('Start date must be a valid ISO 8601 date'),
  query('endDate')
    .optional()
    .isISO8601()
    .withMessage('End date must be a valid ISO 8601 date'),
  query('pageNumber')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page number must be a positive integer'),
  query('pageSize')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Page size must be between 1 and 100'),
  query('minAmount')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Minimum amount must be a positive number'),
  query('maxAmount')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Maximum amount must be a positive number')
];

module.exports = {
  createIncomeValidator,
  updateIncomeValidator,
  getIncomeByIdValidator,
  deleteIncomeValidator,
  getIncomesValidator
};
