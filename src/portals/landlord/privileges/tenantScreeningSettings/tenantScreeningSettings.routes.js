/**
 * ------------------------------------------------------------------
 * File: tenantScreeningSettings.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for tenant screening settings APIs
const { PRIVILEGE_VIEW_APPLICATION, PRIVILEGE_CREATE_APPLICATION, PRIVILEGE_EDIT_APPLICATION, PRIVILEGE_DELETE_APPLICATION } = require('../../../../common/constants/privileges');

module.exports = {
  // Core CRUD operations for screening settings
  'POST /api/v1/landlord/tenant-screening-settings': [PRIVILEGE_CREATE_APPLICATION],
  'GET /api/v1/landlord/tenant-screening-settings': [PRIVILEGE_VIEW_APPLICATION],
  'GET /api/v1/landlord/tenant-screening-settings/:id': [],
  'PUT /api/v1/landlord/tenant-screening-settings/:id': [PRIVILEGE_EDIT_APPLICATION],
  'DELETE /api/v1/landlord/tenant-screening-settings/:id': [PRIVILEGE_DELETE_APPLICATION],
};
