/**
 * ------------------------------------------------------------------
 * File: income.routes.js
 * Module: Src Privileges Income
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Income API Privileges
 * 
 * Defines which privileges are required to access income/invoice endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is publicly accessible (no privilege required).
 */

const {
  PRIVILEGE_VIEW_INCOME,
  PRIVILEGE_CREATE_INCOME,
  PRIVILEGE_EDIT_INCOME,
  PRIVILEGE_DELETE_INCOME,
} = require('../../common/constants/privileges');

module.exports = {
  // Create invoice - requires CREATE_INCOME privilege
  'POST /api/v1/income/invoices': [PRIVILEGE_CREATE_INCOME],
  'POST /api/v1/invoice': [PRIVILEGE_CREATE_INCOME],
  
  // Export invoices - requires VIEW_INCOME privilege
  'GET /api/v1/income/invoices/export': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/invoice/export': [PRIVILEGE_VIEW_INCOME],
  
  // Poll async policy-term invoice generation job status
  'GET /api/v1/invoice/generation/:jobId/status': [PRIVILEGE_VIEW_INCOME],
  
  // View invoice statistics - requires VIEW_INCOME privilege
  'GET /api/v1/income/invoices/statistics': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/invoice/statistics': [PRIVILEGE_VIEW_INCOME],

  // Listing KPI summary-stats - requires VIEW_INCOME privilege
  'GET /api/v1/income/invoices/summary-stats': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/invoice/summary-stats': [PRIVILEGE_VIEW_INCOME],
  
  // View invoices - requires VIEW_INCOME privilege
  'GET /api/v1/income/invoices': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/invoice': [PRIVILEGE_VIEW_INCOME],
  
  // View invoice details - requires VIEW_INCOME privilege
  'GET /api/v1/income/invoices/:id': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/invoice/:id': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/invoice/:id/payment-transactions': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/invoice/:id/payments/:paymentId/reversal-preview': [PRIVILEGE_VIEW_INCOME],
  // Owner/board Pay dialog allocation preview (HOA Owner + Board both have VIEW_INCOME)
  'GET /api/v1/invoice/:id/allocation-preview': [PRIVILEGE_VIEW_INCOME],
  
  // Update invoice - requires EDIT_INCOME privilege
  'PUT /api/v1/income/invoices/:id': [PRIVILEGE_EDIT_INCOME],
  'PUT /api/v1/invoice/:id': [PRIVILEGE_EDIT_INCOME],
  
  // Delete invoice - requires DELETE_INCOME privilege
  'DELETE /api/v1/income/invoices/:id': [PRIVILEGE_DELETE_INCOME],
  'DELETE /api/v1/invoice/:id': [PRIVILEGE_DELETE_INCOME],
  'DELETE /api/v1/invoice/:id/payments/:paymentId': [PRIVILEGE_DELETE_INCOME],
  'POST /api/v1/invoice/:id/apply-credit': [PRIVILEGE_EDIT_INCOME],

  'POST /api/v1/invoice/:id/comments': [PRIVILEGE_EDIT_INCOME],
  'POST /api/v1/invoice/:id/notes': [PRIVILEGE_EDIT_INCOME],
  'PUT /api/v1/invoice/:id/notes/:noteId': [PRIVILEGE_EDIT_INCOME],
  'DELETE /api/v1/invoice/:id/notes/:noteId': [PRIVILEGE_EDIT_INCOME],
  'POST /api/v1/invoice/:id/send-reminder': [PRIVILEGE_EDIT_INCOME],
  'POST /api/v1/invoice/:id/waive': [PRIVILEGE_EDIT_INCOME],
  'POST /api/v1/invoice/:id/unwaive': [PRIVILEGE_EDIT_INCOME],
  'POST /api/v1/invoice/generate-rent-deposit': [PRIVILEGE_CREATE_INCOME],
  'POST /api/v1/invoice/generate-additional-fees': [PRIVILEGE_CREATE_INCOME],
  'POST /api/v1/invoice/generate-deposit-refunds': [PRIVILEGE_CREATE_INCOME],
};
