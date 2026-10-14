/**
 * ------------------------------------------------------------------
 * File: payment-management.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for payment management APIs
const { PRIVILEGE_VIEW_PAYMENT_MANAGEMENT } = require('../../../../common/constants/privileges');

module.exports = {
  'GET /api/v1/landlord/payment-management': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'GET /api/v1/landlord/payment-management/summary': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'GET /api/v1/landlord/payment-management/:propertyId': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'PUT /api/v1/landlord/payment-management/:propertyId/assign-landlord': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'POST /api/v1/landlord/payment-management/:propertyId/record-payment': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'GET /api/v1/landlord/payment-management/:propertyId/payment-history': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
};
