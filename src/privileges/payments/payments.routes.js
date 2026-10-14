/**
 * ------------------------------------------------------------------
 * File: payments.routes.js
 * Module: Src Privileges Payments
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Straddle payment APIs - any authenticated user with at least one privilege may call
 * (residents/owners/board). Empty arrays = auth-only after authorize's privilege presence check.
 */
module.exports = {
  'POST /api/v1/payments/customers': [],
  'PUT /api/v1/payments/customers/:id': [],
  'POST /api/v1/payments/customers/:id/sync': [],
  'DELETE /api/v1/payments/customers/:id': [],
  'GET /api/v1/payments/customers': [],
  'GET /api/v1/payments/customers/:id': [],
  'POST /api/v1/payments/bank-accounts': [],
  'GET /api/v1/payments/bank-accounts': [],
  'GET /api/v1/payments/bank-accounts/:id': [],
  'PUT /api/v1/payments/bank-accounts/:id': [],
  'PATCH /api/v1/payments/bank-accounts/:id/verify': [],
  'POST /api/v1/payments/bank-accounts/:id/sync': [],
  'DELETE /api/v1/payments/bank-accounts/:id': [],
  'POST /api/v1/payments/owner/start-bank-link': [],
  'POST /api/v1/payments/owner/complete-bank-link': [],
  'POST /api/v1/payments/vendor/start-bank-link': [],
  'POST /api/v1/payments/vendor/complete-bank-link': [],
  'POST /api/v1/payments/verify-account/send-otp': [],
  'POST /api/v1/payments/verify-account/verify-otp': [],
  'POST /api/v1/payments/charges': [],
  'GET /api/v1/payments/charges': [],
  'GET /api/v1/payments/charges/:id': [],
  'POST /api/v1/payments/payouts': [],
  'GET /api/v1/payments/payouts': [],
  'GET /api/v1/payments/payouts/:id': [],
  'POST /api/v1/payments/bridge/session': [],
  'POST /api/v1/payments/cards/setup-intent': [],
  'GET /api/v1/payments/cards': [],
  'POST /api/v1/payments/cards/charge': [],
  'DELETE /api/v1/payments/cards/:paymentMethodId': [],
  'PATCH /api/v1/payments/cards/default/:paymentMethodId': [],
};
