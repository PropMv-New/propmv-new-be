/**
 * ------------------------------------------------------------------
 * File: maintenance.routes.js
 * Module: Src Shared Privileges Maintenance
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for maintenance APIs
module.exports = {
  'POST /api/v1/maintenance/request': [],
  'GET /api/v1/maintenance/request': [],
  'GET /api/v1/maintenance/request/export': [],
  'GET /api/v1/maintenance/active-tenants': [],
  'GET /api/v1/maintenance/request/:id': [],
  'PUT /api/v1/maintenance/request/:id': [],
  'DELETE /api/v1/maintenance/request/:id': [],
  'PATCH /api/v1/maintenance/request/:id/resolve': [],
  'POST /api/v1/maintenance/request/:id/comments': ['VIEW_MAINTENANCE', 'CREATE_MAINTENANCE', 'EDIT_MAINTENANCE'],
  'GET /api/v1/maintenance/request/:id/comments': ['VIEW_MAINTENANCE'],
  'POST /api/v1/maintenance/request/:id/notes': [],
  'PUT /api/v1/maintenance/request/:id/notes/:noteId': [],
  'DELETE /api/v1/maintenance/request/:id/notes/:noteId': [],
  'GET /api/v1/maintenance/request/:id/documents': [],
  'POST /api/v1/maintenance/request/:id/documents': [],
  'GET /api/v1/maintenance/request/:id/documents/:metadataId': [],
};
