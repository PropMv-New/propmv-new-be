/**
 * ------------------------------------------------------------------
 * File: dashboard.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for dashboard APIs
const { PRIVILEGE_VIEW_DASHBOARD } = require('../../../../common/constants/privileges');

module.exports = {
  'GET /api/v1/dashboard/summary': [PRIVILEGE_VIEW_DASHBOARD],
};
