/**
 * ------------------------------------------------------------------
 * File: billingSettings.routes.js
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
 * HOA billing settings API Privileges (board members only)
 */

const {
  PRIVILEGE_VIEW_SETTINGS,
  PRIVILEGE_EDIT_SETTINGS,
} = require('../../common/constants/privileges');

module.exports = {
  'GET /api/v1/billing-settings/effective': [PRIVILEGE_VIEW_SETTINGS],
  'GET /api/v1/billing-settings': [PRIVILEGE_VIEW_SETTINGS],
  'PUT /api/v1/billing-settings': [PRIVILEGE_EDIT_SETTINGS],
};
