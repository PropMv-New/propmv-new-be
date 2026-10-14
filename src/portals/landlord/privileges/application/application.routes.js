/**
 * ------------------------------------------------------------------
 * File: application.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for application APIs
const { PRIVILEGE_VIEW_APPLICATION, PRIVILEGE_CREATE_APPLICATION, PRIVILEGE_EDIT_APPLICATION, PRIVILEGE_DELETE_APPLICATION } = require('../../../../common/constants/privileges');

module.exports = {
  // Core CRUD operations
  'POST /api/v1/application': [PRIVILEGE_CREATE_APPLICATION],
  'GET /api/v1/application': [PRIVILEGE_VIEW_APPLICATION],
  'GET /api/v1/application/:id': [PRIVILEGE_VIEW_APPLICATION],
  'PUT /api/v1/application/:id': [PRIVILEGE_EDIT_APPLICATION],
  'DELETE /api/v1/application/:id': [PRIVILEGE_DELETE_APPLICATION],

  // Application submission endpoints (public - no auth required)
  'POST /api/v1/application/submit/:leaseId/:tenantId': [],
  'POST /api/v1/application/submit': [],

  // Tenant blank application creation
  'POST /api/v1/application/tenant/blank': [],

  // Lease invite acknowledgment (public - no auth required)
  'POST /api/v1/application/lease-invite-ack': [],

  // Application listing and filtering
  'GET /api/v1/application/names': [PRIVILEGE_VIEW_APPLICATION],
  'GET /api/v1/application/export': [PRIVILEGE_VIEW_APPLICATION],

  // Application approval and rejection
  'POST /api/v1/application/:id/approve': [PRIVILEGE_EDIT_APPLICATION],
  'POST /api/v1/application/:id/reject': [PRIVILEGE_EDIT_APPLICATION],

  // Screening information
  'PATCH /api/v1/application/:id/screening': [PRIVILEGE_EDIT_APPLICATION],

  // Application notes
  'POST /api/v1/application/:id/notes': [PRIVILEGE_EDIT_APPLICATION],

  // Share application
  'POST /api/v1/application/:id/share-email': [PRIVILEGE_EDIT_APPLICATION],
  'POST /api/v1/application/:id/share-url': [PRIVILEGE_EDIT_APPLICATION],

  // Request application from prospect
  'POST /api/v1/application/request': [PRIVILEGE_CREATE_APPLICATION],

  // Tenant screening settings endpoints
  'GET /api/v1/tenant-screening-settings': [PRIVILEGE_VIEW_APPLICATION],
  'PUT /api/v1/tenant-screening-settings/:id': [PRIVILEGE_EDIT_APPLICATION],
};
