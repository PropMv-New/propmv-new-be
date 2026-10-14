/**
 * Company management APIs - require user-admin privileges.
 */

const {
  PRIVILEGE_VIEW_USERS,
  PRIVILEGE_CREATE_USERS,
  PRIVILEGE_EDIT_USERS,
  PRIVILEGE_DELETE_USERS,
  PRIVILEGE_VIEW_ROLE,
  PRIVILEGE_EDIT_ROLE,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/company': [PRIVILEGE_VIEW_USERS],
  'GET /api/v1/company/:id': [PRIVILEGE_VIEW_USERS],
  'POST /api/v1/company': [PRIVILEGE_CREATE_USERS],
  'PUT /api/v1/company/:id': [PRIVILEGE_EDIT_USERS],
  'DELETE /api/v1/company/:id': [PRIVILEGE_DELETE_USERS],
  'GET /api/v1/company/:id/roles': [PRIVILEGE_VIEW_ROLE],
  'GET /api/v1/company/:id/roles/:roleId': [PRIVILEGE_VIEW_ROLE],
  'POST /api/v1/company/:id/roles': [PRIVILEGE_EDIT_ROLE],
  'PUT /api/v1/company/:id/roles/:roleId': [PRIVILEGE_EDIT_ROLE],
  'DELETE /api/v1/company/:id/roles/:roleId': [PRIVILEGE_EDIT_ROLE],
};
