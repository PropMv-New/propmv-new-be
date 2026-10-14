/**
 * Rainforest payment APIs - auth-only (same pattern as Straddle/Stripe payment routes).
 */

module.exports = {
  'GET /api/v1/payments/rainforest/config': [],
  'GET /api/v1/payments/rainforest/merchants': [],
  'POST /api/v1/payments/rainforest/merchants/initialize': [],
  'GET /api/v1/payments/rainforest/merchants/status': [],
  'POST /api/v1/payments/rainforest/merchants/onboarding-session': [],
  'POST /api/v1/payments/rainforest/merchants/:accountId/simulate-approval': [],
  'GET /api/v1/payments/rainforest/merchants/:accountId': [],
  'GET /api/v1/payments/rainforest/merchants/:accountId/deposit-methods': [],
  'POST /api/v1/payments/rainforest/merchants/:accountId/deposit-methods/sync': [],
  'POST /api/v1/payments/rainforest/merchants/:accountId/deposit-methods/initialize': [],
  'POST /api/v1/payments/rainforest/merchants/:accountId/deposit-methods/register': [],
  'POST /api/v1/payments/rainforest/merchants/:accountId/deposit-methods/:depositMethodId/set-primary': [],
  'POST /api/v1/payments/rainforest/payment-methods/initialize': [],
  'POST /api/v1/payments/rainforest/payment-methods/register': [],
  'GET /api/v1/payments/rainforest/payment-methods': [],
  'POST /api/v1/payments/rainforest/payins/validate': [],
  'POST /api/v1/payments/rainforest/payins/execute': [],
  'GET /api/v1/payments/rainforest/payins/:payinId': [],
  'POST /api/v1/payments/rainforest/refunds/request': [],
  'GET /api/v1/payments/rainforest/refunds/:refundId': [],
};
