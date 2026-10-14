/**
 * ------------------------------------------------------------------
 * File: maintenance.routes.js
 * Module: Src Privileges Maintenance
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Maintenance API Privileges
 * 
 * Defines which privileges are required to access maintenance endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is publicly accessible (no privilege required).
 */

const {
  PRIVILEGE_VIEW_MAINTENANCE,
  PRIVILEGE_CREATE_MAINTENANCE,
  PRIVILEGE_EDIT_MAINTENANCE,
  PRIVILEGE_DELETE_MAINTENANCE,
} = require('../../common/constants/privileges');

module.exports = {
  // Create maintenance request - requires CREATE_MAINTENANCE privilege
  'POST /api/v1/maintenance/request': [PRIVILEGE_CREATE_MAINTENANCE],

  // View maintenance requests - requires VIEW_MAINTENANCE privilege
  'GET /api/v1/maintenance/request': [PRIVILEGE_VIEW_MAINTENANCE],
  'GET /api/v1/maintenance/request/export': [PRIVILEGE_VIEW_MAINTENANCE],

  // Get active tenants for maintenance - requires VIEW_MAINTENANCE privilege
  'GET /api/v1/maintenance/active-tenants': [PRIVILEGE_VIEW_MAINTENANCE],

  // View maintenance request details - requires VIEW_MAINTENANCE privilege
  'GET /api/v1/maintenance/request/:id': [PRIVILEGE_VIEW_MAINTENANCE],

  // Update maintenance request - requires EDIT_MAINTENANCE privilege
  'PUT /api/v1/maintenance/request/:id': [PRIVILEGE_EDIT_MAINTENANCE],

  // Delete maintenance request - requires DELETE_MAINTENANCE privilege
  'DELETE /api/v1/maintenance/request/:id': [PRIVILEGE_DELETE_MAINTENANCE],

  // Resolve maintenance request - board editors and ticket creators (HOA owners)
  'PATCH /api/v1/maintenance/request/:id/resolve': [
    PRIVILEGE_EDIT_MAINTENANCE,
    PRIVILEGE_CREATE_MAINTENANCE,
  ],

  // Reject maintenance request - same privileges as resolve (vendors use EDIT_MAINTENANCE)
  'PATCH /api/v1/maintenance/request/:id/reject': [
    PRIVILEGE_EDIT_MAINTENANCE,
    PRIVILEGE_CREATE_MAINTENANCE,
  ],

  // Add maintenance comments - participants with view/create/edit maintenance access
  'POST /api/v1/maintenance/request/:id/comments': [
    PRIVILEGE_VIEW_MAINTENANCE,
    PRIVILEGE_CREATE_MAINTENANCE,
    PRIVILEGE_EDIT_MAINTENANCE,
  ],
  'GET /api/v1/maintenance/request/:id/comments': [PRIVILEGE_VIEW_MAINTENANCE],

  // Add maintenance notes - requires EDIT_MAINTENANCE privilege
  'POST /api/v1/maintenance/request/:id/notes': [PRIVILEGE_EDIT_MAINTENANCE],
  'PUT /api/v1/maintenance/request/:id/notes/:noteId': [PRIVILEGE_EDIT_MAINTENANCE],
  'DELETE /api/v1/maintenance/request/:id/notes/:noteId': [PRIVILEGE_EDIT_MAINTENANCE],

  // View maintenance documents - requires VIEW_MAINTENANCE privilege
  'GET /api/v1/maintenance/request/:id/documents': [PRIVILEGE_VIEW_MAINTENANCE],

  // Upload maintenance documents - editors and ticket creators
  'POST /api/v1/maintenance/request/:id/documents': [
    PRIVILEGE_EDIT_MAINTENANCE,
    PRIVILEGE_CREATE_MAINTENANCE,
  ],
  'GET /api/v1/maintenance/request/:id/documents/:metadataId': [PRIVILEGE_VIEW_MAINTENANCE],

  // Assign vendor - board editors and HOA owners who can create tickets
  'PATCH /api/v1/maintenance/request/:id/assign-vendor': [
    PRIVILEGE_EDIT_MAINTENANCE,
    PRIVILEGE_CREATE_MAINTENANCE,
  ],
};
