/**
 * Straddle Account APIs - auth-only for board/owner/landlord payment onboarding.
 * Empty arrays = any authenticated user with at least one privilege.
 */

module.exports = {
  'POST /api/v1/accounts': [],
  'GET /api/v1/accounts': [],
  'GET /api/v1/accounts/onboarding/environment': [],
  'GET /api/v1/accounts/entity/:entityType/:entityId': [],
  'GET /api/v1/accounts/:id': [],
  'PATCH /api/v1/accounts/:id': [],
  'POST /api/v1/accounts/:id/sync': [],
  'DELETE /api/v1/accounts/:id': [],
  'POST /api/v1/accounts/:id/banks': [],
  'GET /api/v1/accounts/:id/banks': [],
  'GET /api/v1/accounts/:id/banks/:bankId': [],
  'PUT /api/v1/accounts/:id/banks/:bankId': [],
  'DELETE /api/v1/accounts/:id/banks/:bankId': [],
  'PATCH /api/v1/accounts/:id/banks/:bankId/verify': [],
  'POST /api/v1/accounts/:id/banks/:bankId/sync': [],
  'POST /api/v1/accounts/:id/bridge/session': [],
  'PATCH /api/v1/accounts/:id/onboarding/step': [],
  'POST /api/v1/accounts/:id/onboarding/submit': [],
  'GET /api/v1/accounts/:id/representatives': [],
  'POST /api/v1/accounts/:id/representatives': [],
  'PATCH /api/v1/accounts/:id/representatives/:repId': [],
  'PATCH /api/v1/accounts/:id/banks/:bankId/primary': [],
};
