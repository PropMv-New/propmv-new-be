/**
 * Landlord payment-management APIs.
 * Paths use portal-stripped form (/api/v1/payment-management/...) for authorize matching.
 */

const { PRIVILEGE_VIEW_PAYMENT_MANAGEMENT } = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/payment-management': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'GET /api/v1/payment-management/settings': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'POST /api/v1/payment-management/settings': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'GET /api/v1/payment-management/summary': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'GET /api/v1/payment-management/:propertyId': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'PUT /api/v1/payment-management/:propertyId/assign-landlord': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'POST /api/v1/payment-management/:propertyId/record-payment': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
  'GET /api/v1/payment-management/:propertyId/payment-history': [PRIVILEGE_VIEW_PAYMENT_MANAGEMENT],
};
