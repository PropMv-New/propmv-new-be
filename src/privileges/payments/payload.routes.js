/**
 * Payload payment APIs - auth-only (same pattern as Rainforest/Straddle).
 * Check21 submit requires EDIT_INCOME (board Record Payment class).
 */

const { PRIVILEGE_EDIT_INCOME } = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/payments/payload/config': [],
  'GET /api/v1/payments/payload/merchants': [],
  'POST /api/v1/payments/payload/merchants/initialize': [],
  'GET /api/v1/payments/payload/merchants/status': [],
  'POST /api/v1/payments/payload/merchants/onboarding-session': [],
  'POST /api/v1/payments/payload/merchants/:accountId/register-processing-account': [],
  'POST /api/v1/payments/payload/merchants/:accountId/simulate-approval': [],
  'GET /api/v1/payments/payload/merchants/:accountId': [],
  'GET /api/v1/payments/payload/merchants/:accountId/deposit-methods': [],
  'POST /api/v1/payments/payload/merchants/:accountId/deposit-methods/sync': [],
  'POST /api/v1/payments/payload/merchants/:accountId/deposit-methods/initialize': [],
  'POST /api/v1/payments/payload/merchants/:accountId/deposit-methods/register': [],
  'POST /api/v1/payments/payload/merchants/:accountId/deposit-methods/:depositMethodId/set-primary': [],
  'POST /api/v1/payments/payload/payment-methods/initialize': [],
  'POST /api/v1/payments/payload/payment-methods/initialize-edit': [],
  'POST /api/v1/payments/payload/payment-methods/register': [],
  'GET /api/v1/payments/payload/payment-methods': [],
  'PUT /api/v1/payments/payload/payment-methods/:methodId': [],
  'DELETE /api/v1/payments/payload/payment-methods/:methodId': [],
  'GET /api/v1/payments/payload/autopay': [],
  'POST /api/v1/payments/payload/autopay/enable': [],
  'POST /api/v1/payments/payload/autopay/disable': [],
  'PUT /api/v1/payments/payload/autopay/payment-method': [],
  'GET /api/v1/payments/payload/vendor-invoices/:vendorInvoiceId/pay-eligibility': [],
  'POST /api/v1/payments/payload/vendor-invoices/:vendorInvoiceId/payins/validate': [],
  'POST /api/v1/payments/payload/vendor-invoices/:vendorInvoiceId/payins/execute': [],
  'GET /api/v1/payments/payload/vendor-payins/:vendorPayinId': [],
  'POST /api/v1/payments/payload/payins/validate': [],
  'POST /api/v1/payments/payload/payins/execute': [],
  'GET /api/v1/payments/payload/payins/:payinId': [],
  'POST /api/v1/payments/payload/refunds/request': [],
  'GET /api/v1/payments/payload/refunds/:refundId': [],
  'GET /api/v1/payments/payload/operations/reconciliation': [],
  'POST /api/v1/payments/payload/operations/retry-webhooks': [],
  'POST /api/v1/payments/payload/check21/submit-for-invoice': [PRIVILEGE_EDIT_INCOME],
};
