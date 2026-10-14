/**
 * ------------------------------------------------------------------
 * File: roles.routes.js
 * Module: Src Privileges Auth
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

// Privileges for roles APIs
const {
  PRIVILEGE_VIEW_ROLE,
  PRIVILEGE_CREATE_ROLE,
  PRIVILEGE_EDIT_ROLE,
  PRIVILEGE_DELETE_ROLE,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/auth/role': [PRIVILEGE_VIEW_ROLE],
  'GET /api/v1/auth/role/:id': [PRIVILEGE_VIEW_ROLE],
  'POST /api/v1/auth/role': [PRIVILEGE_CREATE_ROLE],
  'PUT /api/v1/auth/role/:id': [PRIVILEGE_EDIT_ROLE],
  'DELETE /api/v1/auth/role/:id': [PRIVILEGE_DELETE_ROLE],
  'GET /api/v1/auth/permissions': [PRIVILEGE_VIEW_ROLE],
};
