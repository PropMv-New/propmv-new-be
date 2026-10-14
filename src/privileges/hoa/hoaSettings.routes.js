/**
 * ------------------------------------------------------------------
 * File: hoaSettings.routes.js
 * Module: Src Privileges Hoa
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize
 * ------------------------------------------------------------------
 */

/**
 * HOA settings API Privileges
 */

const {
  PRIVILEGE_VIEW_SETTINGS,
  PRIVILEGE_EDIT_SETTINGS,
  PRIVILEGE_VIEW_INCOME,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/hoa-settings': [PRIVILEGE_VIEW_SETTINGS],
  'GET /api/v1/hoa-settings/:hoaId': [PRIVILEGE_VIEW_SETTINGS],
  'GET /api/v1/hoa-settings/:hoaId/payment-policy': [PRIVILEGE_VIEW_INCOME],
  'PUT /api/v1/hoa-settings': [PRIVILEGE_EDIT_SETTINGS],
  'PUT /api/v1/hoa-settings/:hoaId': [PRIVILEGE_EDIT_SETTINGS],
};
