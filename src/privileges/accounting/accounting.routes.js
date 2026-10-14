/**
 * ------------------------------------------------------------------
 * File: accounting.routes.js
 * Module: Src Privileges Accounting
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for accounting APIs (routes defined in src/modules/accounting/routes/accounting.js)
module.exports = {
  'GET /api/v1/accounting/properties/:propertyId/balance': [],
  'POST /api/v1/accounting/reconciliation': [],
  'POST /api/v1/accounting/1099/generate': [],
};
