/**
 * Vendor user management privileges (board creates/lists vendors).
 * Mounted at /api/v1/hoa/vendors → /api/v1/vendors
 */

const {
  PRIVILEGE_VIEW_EXPENSE,
  PRIVILEGE_CREATE_EXPENSE,
  PRIVILEGE_EDIT_EXPENSE,
  PRIVILEGE_VIEW_MAINTENANCE,
  PRIVILEGE_EDIT_MAINTENANCE,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/vendors': [PRIVILEGE_VIEW_EXPENSE, PRIVILEGE_VIEW_MAINTENANCE],
  'POST /api/v1/vendors': [PRIVILEGE_CREATE_EXPENSE, PRIVILEGE_EDIT_MAINTENANCE],
  'GET /api/v1/vendors/:id': [PRIVILEGE_VIEW_EXPENSE, PRIVILEGE_VIEW_MAINTENANCE],
  'PUT /api/v1/vendors/:id': [PRIVILEGE_EDIT_EXPENSE, PRIVILEGE_EDIT_MAINTENANCE],
  'DELETE /api/v1/vendors/:id': [PRIVILEGE_EDIT_EXPENSE, PRIVILEGE_EDIT_MAINTENANCE],
  'POST /api/v1/vendors/:id/invite': [PRIVILEGE_CREATE_EXPENSE, PRIVILEGE_EDIT_MAINTENANCE],
};
