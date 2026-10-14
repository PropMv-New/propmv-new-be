/**
 * ------------------------------------------------------------------
 * File: leases.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for leasing APIs
const { PRIVILEGE_VIEW_LEASE, PRIVILEGE_CREATE_LEASE, PRIVILEGE_EDIT_LEASE, PRIVILEGE_DELETE_LEASE } = require('../../../../common/constants/privileges');

module.exports = {
  // Core CRUD operations for leases
  'POST /api/v1/leasing/lease': [PRIVILEGE_CREATE_LEASE],
  'GET /api/v1/leasing/lease': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/:id': [PRIVILEGE_VIEW_LEASE],
  'PUT /api/v1/leasing/lease/:id': [PRIVILEGE_EDIT_LEASE],
  'DELETE /api/v1/leasing/lease/:id': [PRIVILEGE_DELETE_LEASE],

  // Lease listing and filtering
  'GET /api/v1/leasing/lease/list': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/tenant': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/export': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/tenure-availability': [PRIVILEGE_VIEW_LEASE],

  // Lease lifecycle operations
  'POST /api/v1/leasing/lease/:id/renew': [PRIVILEGE_EDIT_LEASE],
  'POST /api/v1/leasing/lease/:id/activate': [PRIVILEGE_EDIT_LEASE],
  'PATCH /api/v1/leasing/lease/:id/terminate': [PRIVILEGE_EDIT_LEASE],

  // Lease document management
  'POST /api/v1/leasing/lease/:id/document': [PRIVILEGE_EDIT_LEASE],
  'POST /api/v1/leasing/lease/:id/notes': [PRIVILEGE_EDIT_LEASE],

  // Lease templates - creation and management
  'POST /api/v1/leasing/creator/:createdBy/templates': [PRIVILEGE_CREATE_LEASE],
  'GET /api/v1/leasing/creator/:createdBy/templates': [PRIVILEGE_VIEW_LEASE],
  'PUT /api/v1/leasing/creator/:createdBy/templates/:templateId': [PRIVILEGE_EDIT_LEASE],
  'DELETE /api/v1/leasing/creator/:createdBy/templates/:templateId': [PRIVILEGE_DELETE_LEASE],

  // Lease templates - retrieval and download
  'GET /api/v1/leasing/templates/:templateId': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/templates/:templateId/download': [PRIVILEGE_VIEW_LEASE],
};
