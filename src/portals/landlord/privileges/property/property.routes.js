/**
 * ------------------------------------------------------------------
 * File: property.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for property APIs
const { PRIVILEGE_VIEW_PROPERTY, PRIVILEGE_CREATE_PROPERTY, PRIVILEGE_EDIT_PROPERTY, PRIVILEGE_DELETE_PROPERTY } = require('../../../../common/constants/privileges');

module.exports = {
  // Core CRUD operations
  'POST /api/v1/property/properties': [PRIVILEGE_CREATE_PROPERTY],
  'GET /api/v1/property/properties': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/property/properties/:id': [PRIVILEGE_VIEW_PROPERTY],
  'PUT /api/v1/property/properties': [PRIVILEGE_EDIT_PROPERTY],
  'DELETE /api/v1/property/properties/:id': [PRIVILEGE_DELETE_PROPERTY],

  // Property search and export
  'GET /api/v1/property/search': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/property/export': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/property/properties/export': [PRIVILEGE_VIEW_PROPERTY],
  
  // Property import and template
  'POST /api/v1/property/properties/import': [PRIVILEGE_CREATE_PROPERTY],
  'GET /api/v1/property/template': [PRIVILEGE_VIEW_PROPERTY],

  // Image management
  'POST /api/v1/property/properties/:id/images': [PRIVILEGE_EDIT_PROPERTY],
  'PUT /api/v1/property/properties/:id/profile-image': [PRIVILEGE_EDIT_PROPERTY],
  'DELETE /api/v1/property/properties/:id/images': [PRIVILEGE_EDIT_PROPERTY],

  // Property status and metadata
  'PATCH /api/v1/property/properties/:id/archive': [PRIVILEGE_EDIT_PROPERTY],
  'POST /api/v1/property/properties/:id/notes': [PRIVILEGE_EDIT_PROPERTY],
};
