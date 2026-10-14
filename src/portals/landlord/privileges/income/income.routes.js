/**
 * ------------------------------------------------------------------
 * File: income.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for income APIs
const { PRIVILEGE_VIEW_INCOME, PRIVILEGE_CREATE_INCOME, PRIVILEGE_EDIT_INCOME, PRIVILEGE_DELETE_INCOME } = require('../../../../common/constants/privileges');

module.exports = {
  // Core CRUD operations for invoices
  'POST /api/v1/income': [PRIVILEGE_CREATE_INCOME],
  'GET /api/v1/income': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/income/:id': [PRIVILEGE_VIEW_INCOME],
  'PUT /api/v1/income/:id': [PRIVILEGE_EDIT_INCOME],
  'DELETE /api/v1/income/:id': [PRIVILEGE_DELETE_INCOME],

  // Invoice listing and filtering
  'GET /api/v1/income/export': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/income/export-multi': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/income/statistics': [PRIVILEGE_VIEW_INCOME],

  // Invoice operations and actions
  'POST /api/v1/income/:id/comments': [PRIVILEGE_EDIT_INCOME],
  'POST /api/v1/income/:id/remind': [PRIVILEGE_EDIT_INCOME],

  // Bulk invoice generation
  'POST /api/v1/income/generate-rent-deposit': [PRIVILEGE_CREATE_INCOME],
  'POST /api/v1/income/generate-additional-fees': [PRIVILEGE_CREATE_INCOME],
  'POST /api/v1/income/generate-deposit-refunds': [PRIVILEGE_CREATE_INCOME],
};
