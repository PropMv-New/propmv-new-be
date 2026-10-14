/**
 * ------------------------------------------------------------------
 * File: application.routes.js
 * Module: Src Privileges Application
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Application API Privileges
 * 
 * Defines which privileges are required to access application endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is publicly accessible (no privilege required).
 */

const {
  PRIVILEGE_VIEW_APPLICATION,
  PRIVILEGE_CREATE_APPLICATION,
  PRIVILEGE_EDIT_APPLICATION,
  PRIVILEGE_DELETE_APPLICATION,
} = require('../../common/constants/privileges');

module.exports = {
  // Create application - requires CREATE_APPLICATION privilege
  'POST /api/v1/application': [PRIVILEGE_CREATE_APPLICATION],
  
  // View applications - requires VIEW_APPLICATION privilege
  'GET /api/v1/application': [PRIVILEGE_VIEW_APPLICATION],
  
  // View application details - requires VIEW_APPLICATION privilege
  'GET /api/v1/application/:id': [PRIVILEGE_VIEW_APPLICATION],
  
  // Update application - requires EDIT_APPLICATION privilege
  'PUT /api/v1/application/:id': [PRIVILEGE_EDIT_APPLICATION],
  
  // Delete application - requires DELETE_APPLICATION privilege
  'DELETE /api/v1/application/:id': [PRIVILEGE_DELETE_APPLICATION],
  
  // Approve application - requires EDIT_APPLICATION privilege
  'POST /api/v1/application/:id/approve': [PRIVILEGE_EDIT_APPLICATION],
};
