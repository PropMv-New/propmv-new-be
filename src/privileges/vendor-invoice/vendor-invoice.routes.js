/**
 * Vendor invoice API privileges (normalized path strips /hoa prefix).
 * Mounted at /api/v1/hoa/vendor-invoice → /api/v1/vendor-invoice
 */

const {
  PRIVILEGE_VIEW_INCOME,
  PRIVILEGE_CREATE_INCOME,
  PRIVILEGE_EDIT_INCOME,
  PRIVILEGE_DELETE_INCOME,
  PRIVILEGE_VIEW_DASHBOARD,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/vendor-invoice/received/statistics': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/vendor-invoice/received': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/vendor-invoice/dashboard': [PRIVILEGE_VIEW_INCOME, PRIVILEGE_VIEW_DASHBOARD],
  'GET /api/v1/vendor-invoice/statistics': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/vendor-invoice/assignable-users': [PRIVILEGE_VIEW_INCOME, PRIVILEGE_CREATE_INCOME],
  'POST /api/v1/vendor-invoice': [PRIVILEGE_CREATE_INCOME],
  'GET /api/v1/vendor-invoice': [PRIVILEGE_VIEW_INCOME],
  'GET /api/v1/vendor-invoice/:id': [PRIVILEGE_VIEW_INCOME],
  'PUT /api/v1/vendor-invoice/:id': [PRIVILEGE_EDIT_INCOME],
  'POST /api/v1/vendor-invoice/:id/notes': [PRIVILEGE_VIEW_INCOME, PRIVILEGE_EDIT_INCOME, PRIVILEGE_CREATE_INCOME],
  'PUT /api/v1/vendor-invoice/:id/notes/:noteId': [PRIVILEGE_VIEW_INCOME, PRIVILEGE_EDIT_INCOME, PRIVILEGE_CREATE_INCOME],
  'DELETE /api/v1/vendor-invoice/:id/notes/:noteId': [PRIVILEGE_VIEW_INCOME, PRIVILEGE_EDIT_INCOME, PRIVILEGE_CREATE_INCOME],
  'DELETE /api/v1/vendor-invoice/:id': [PRIVILEGE_DELETE_INCOME, PRIVILEGE_EDIT_INCOME],
};
