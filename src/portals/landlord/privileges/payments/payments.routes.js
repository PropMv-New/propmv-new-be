/**
 * ------------------------------------------------------------------
 * File: payments.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for payments APIs (routes defined in src/portals/landlord/modules/payments/routes/payments.js)
module.exports = {
  'POST /api/v1/payments/': [],
  'POST /api/v1/payments/webhook': [],
  'POST /api/v1/payments/walkin': [],
  'POST /api/v1/payments/rent-report': [],
};
