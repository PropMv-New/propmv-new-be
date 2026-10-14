/**
 * ------------------------------------------------------------------
 * File: owners.routes.js
 * Module: Src Privileges Owners
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize
 * ------------------------------------------------------------------
 */

/**
 * Owner management API Privileges (HOA portal)
 */

const {
  PRIVILEGE_VIEW_OWNER,
  PRIVILEGE_CREATE_OWNER,
  PRIVILEGE_EDIT_OWNER,
  PRIVILEGE_DELETE_OWNER,
  PRIVILEGE_VIEW_PROPERTY,
  PRIVILEGE_CREATE_PROPERTY,
  PRIVILEGE_EDIT_PROPERTY,
  PRIVILEGE_DELETE_PROPERTY,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/owners/picker': [PRIVILEGE_VIEW_OWNER],
  'GET /api/v1/owners': [PRIVILEGE_VIEW_OWNER],
  'POST /api/v1/owners': [PRIVILEGE_CREATE_OWNER],
  'POST /api/v1/owners/import': [PRIVILEGE_CREATE_OWNER],
  'GET /api/v1/owners/export': [PRIVILEGE_VIEW_OWNER],
  'GET /api/v1/owners/template': [PRIVILEGE_VIEW_OWNER],

  'POST /api/v1/owners/units/import': [PRIVILEGE_CREATE_PROPERTY],
  'GET /api/v1/owners/units/import/:jobId/status': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/owners/units/export': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/owners/units/template': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/owners/deposit-bank-accounts/:bankAccountId/usage': [PRIVILEGE_VIEW_PROPERTY],
  'POST /api/v1/owners/deposit-bank-accounts/reassign': [PRIVILEGE_EDIT_PROPERTY],

  'POST /api/v1/owners/units': [PRIVILEGE_CREATE_PROPERTY],
  'GET /api/v1/owners/units/:id': [PRIVILEGE_VIEW_PROPERTY],
  'POST /api/v1/owners/units/:id/adjustment': [PRIVILEGE_EDIT_PROPERTY],
  'POST /api/v1/owners/units/balances': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/owners/units/:id/balance': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/owners/units/:id/ledger': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/owners/units/:id/ledger/invoice/:invoiceId': [PRIVILEGE_VIEW_PROPERTY],
  'POST /api/v1/owners/units/:id/add-owner': [PRIVILEGE_EDIT_OWNER],
  'POST /api/v1/owners/units/:id/remove-owner': [PRIVILEGE_EDIT_OWNER],
  'POST /api/v1/owners/units/:id/change-ownership': [PRIVILEGE_EDIT_OWNER],
  'GET /api/v1/owners/units/:id/ownership-events/:logId/revert-preview': [PRIVILEGE_EDIT_OWNER],
  'POST /api/v1/owners/units/:id/ownership-events/:logId/revert': [PRIVILEGE_EDIT_OWNER],
  'PUT /api/v1/owners/units/:id': [PRIVILEGE_EDIT_PROPERTY],
  'DELETE /api/v1/owners/units/:id': [PRIVILEGE_DELETE_PROPERTY],

  'GET /api/v1/owners/:id': [PRIVILEGE_VIEW_OWNER],
  'POST /api/v1/owners/:id/resend-invite': [PRIVILEGE_EDIT_OWNER],
  'PUT /api/v1/owners/:id': [PRIVILEGE_EDIT_OWNER],
  'PATCH /api/v1/owners/:id/archive': [PRIVILEGE_EDIT_OWNER],
  'GET /api/v1/owners/:id/delete-preview': [PRIVILEGE_VIEW_OWNER],
  'DELETE /api/v1/owners/:id': [PRIVILEGE_DELETE_OWNER],
  'POST /api/v1/owners/:id/notes': [PRIVILEGE_EDIT_OWNER],
  'PUT /api/v1/owners/:id/notes/:noteId': [PRIVILEGE_EDIT_OWNER],
  'DELETE /api/v1/owners/:id/notes/:noteId': [PRIVILEGE_EDIT_OWNER],
};
