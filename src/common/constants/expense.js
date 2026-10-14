/**
 * ------------------------------------------------------------------
 * File: expense.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for expense.
 *
 * Used By:
 * expense.model, expense.service, expense.validator
 * ------------------------------------------------------------------
 */

// Expense-related constants

const EXPENSE_STATUS = {
  PENDING: 'pending',
  OVERDUE: 'overdue',
  PAID: 'paid',
  PARTIALLY_PAID: 'partially_paid',
};

// Array of all valid expense statuses for validation
const EXPENSE_STATUS_VALUES = Object.values(EXPENSE_STATUS);

module.exports = {
  EXPENSE_STATUS,
  EXPENSE_STATUS_VALUES,
};
