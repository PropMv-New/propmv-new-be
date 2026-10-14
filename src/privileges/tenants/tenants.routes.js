/**
 * ------------------------------------------------------------------
 * File: tenants.routes.js
 * Module: Src Privileges Tenants
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Tenants API Privileges
 *
 * Defines which privileges are required to access tenant endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is auth-only (no specific privilege required).
 */

const {
  PRIVILEGE_VIEW_TENANTS,
  PRIVILEGE_CREATE_TENANTS,
  PRIVILEGE_EDIT_TENANTS,
  PRIVILEGE_DELETE_TENANTS,
} = require('../../common/constants/privileges');

module.exports = {
  // Core CRUD operations
  'POST /api/v1/tenants': [PRIVILEGE_CREATE_TENANTS],
  'GET /api/v1/tenants': [PRIVILEGE_VIEW_TENANTS],
  'GET /api/v1/tenants/:id': [PRIVILEGE_VIEW_TENANTS],
  'PUT /api/v1/tenants/:id': [PRIVILEGE_EDIT_TENANTS],
  'DELETE /api/v1/tenants/:id': [PRIVILEGE_DELETE_TENANTS],

  // Tenant setup and configuration
  'POST /api/v1/tenants/setup': [PRIVILEGE_CREATE_TENANTS],
  'PUT /api/v1/tenants/setup/:id': [PRIVILEGE_EDIT_TENANTS],
  'PUT /api/v1/tenants/update-setup': [PRIVILEGE_EDIT_TENANTS],
  'POST /api/v1/tenants/send-application': [PRIVILEGE_EDIT_TENANTS],

  // Tenant data retrieval and filtering
  'GET /api/v1/tenants/names': [PRIVILEGE_VIEW_TENANTS],
  'GET /api/v1/tenants/details': [PRIVILEGE_VIEW_TENANTS],
  'GET /api/v1/tenants/list-with-details': [PRIVILEGE_VIEW_TENANTS],
  'GET /api/v1/tenants/search/by-email': [PRIVILEGE_VIEW_TENANTS],

  // Import and export
  'POST /api/v1/tenants/import': [PRIVILEGE_CREATE_TENANTS],
  'GET /api/v1/tenants/export': [PRIVILEGE_VIEW_TENANTS],
  'GET /api/v1/tenants/export-multi': [PRIVILEGE_VIEW_TENANTS],

  // Document management
  'POST /api/v1/tenants/:id/documents': [PRIVILEGE_EDIT_TENANTS],

  // Tenant status and communications
  'PATCH /api/v1/tenants/:id/archive': [PRIVILEGE_EDIT_TENANTS],
  'PATCH /api/v1/tenants/:id/unarchive': [PRIVILEGE_EDIT_TENANTS],
  'POST /api/v1/tenants/resend-invite': [PRIVILEGE_EDIT_TENANTS],
  'POST /api/v1/tenants/resend-lease-communication': [PRIVILEGE_EDIT_TENANTS],

  // Lease and screening context
  'GET /api/v1/tenants/lease-onboarding-status/:leaseId': [PRIVILEGE_VIEW_TENANTS],
  'GET /api/v1/tenants/screening-context/:leaseId/:tenantId': [], // Auth-only
};
