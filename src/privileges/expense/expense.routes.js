/**
 * ------------------------------------------------------------------
 * File: expense.routes.js
 * Module: Src Privileges Expense
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize
 * ------------------------------------------------------------------
 */

/**
 * Expense API Privileges (HOA + Landlord portals)
 */

const {
  PRIVILEGE_VIEW_EXPENSE,
  PRIVILEGE_CREATE_EXPENSE,
  PRIVILEGE_EDIT_EXPENSE,
  PRIVILEGE_DELETE_EXPENSE,
} = require('../../common/constants/privileges');

module.exports = {
  'POST /api/v1/expense/payees': [PRIVILEGE_CREATE_EXPENSE],
  'GET /api/v1/expense/payees': [PRIVILEGE_VIEW_EXPENSE],
  'GET /api/v1/expense/payees/:id': [PRIVILEGE_VIEW_EXPENSE],
  'PUT /api/v1/expense/payees/:id': [PRIVILEGE_EDIT_EXPENSE],
  'DELETE /api/v1/expense/payees/:id': [PRIVILEGE_DELETE_EXPENSE],

  'GET /api/v1/expense/categories': [PRIVILEGE_VIEW_EXPENSE],
  'POST /api/v1/expense/categories': [PRIVILEGE_CREATE_EXPENSE],
  'GET /api/v1/expense/categories/:id': [PRIVILEGE_VIEW_EXPENSE],
  'PATCH /api/v1/expense/categories/:id': [PRIVILEGE_EDIT_EXPENSE],

  'POST /api/v1/expense': [PRIVILEGE_CREATE_EXPENSE],
  'GET /api/v1/expense': [PRIVILEGE_VIEW_EXPENSE],
  'GET /api/v1/expense/:id': [PRIVILEGE_VIEW_EXPENSE],
  'PUT /api/v1/expense/:id': [PRIVILEGE_EDIT_EXPENSE],
  'POST /api/v1/expense/:id/notes': [PRIVILEGE_EDIT_EXPENSE],
  'PATCH /api/v1/expense/:id/mark-paid': [PRIVILEGE_EDIT_EXPENSE],
  'DELETE /api/v1/expense/:id': [PRIVILEGE_DELETE_EXPENSE],
  'POST /api/v1/expense/:id/items/:itemId/document': [PRIVILEGE_EDIT_EXPENSE],
};
