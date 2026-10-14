/**
 * ------------------------------------------------------------------
 * File: dashboard.routes.js
 * Module: Src Privileges Dashboard
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Dashboard API Privileges
 * 
 * Defines which privileges are required to access dashboard endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is publicly accessible (no privilege required).
 */

const {
  PRIVILEGE_VIEW_DASHBOARD,
} = require('../../common/constants/privileges');

module.exports = {
  // Get dashboard summary - accessible to users with VIEW_DASHBOARD privilege
  'GET /api/v1/dashboard/summary': [PRIVILEGE_VIEW_DASHBOARD],
  'GET /api/v1/dashboard/recent-activity': [PRIVILEGE_VIEW_DASHBOARD],
  'GET /api/v1/dashboard/activity/recent': [PRIVILEGE_VIEW_DASHBOARD],
  'POST /api/v1/dashboard/activity/log': [PRIVILEGE_VIEW_DASHBOARD],
};
