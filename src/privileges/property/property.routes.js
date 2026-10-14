/**
 * ------------------------------------------------------------------
 * File: property.routes.js
 * Module: Src Privileges Property
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Property API Privileges
 * 
 * Defines which privileges are required to access property endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is publicly accessible (no privilege required).
 */

const {
  PRIVILEGE_VIEW_PROPERTY,
  PRIVILEGE_CREATE_PROPERTY,
  PRIVILEGE_EDIT_PROPERTY,
  PRIVILEGE_DELETE_PROPERTY,
  PRIVILEGE_VIEW_EMAIL,
  PRIVILEGE_VIEW_INCOME,
} = require('../../common/constants/privileges');

module.exports = {
  // Create property - requires CREATE_PROPERTY privilege
  'POST /api/v1/property/properties': [PRIVILEGE_CREATE_PROPERTY],
  
  // Update property - requires EDIT_PROPERTY privilege
  'PUT /api/v1/property/properties': [PRIVILEGE_EDIT_PROPERTY],

  // HOA / shared search & portfolio surfaces
  'GET /api/v1/property/search': [PRIVILEGE_VIEW_PROPERTY],
  // HOA owners use picker for email/income filters; board members use VIEW_PROPERTY.
  'GET /api/v1/property/picker': [
    PRIVILEGE_VIEW_PROPERTY,
    PRIVILEGE_VIEW_EMAIL,
    PRIVILEGE_VIEW_INCOME,
  ],
  'GET /api/v1/property/portfolio-overview': [PRIVILEGE_VIEW_PROPERTY],

  // Landlord export / template helpers
  'GET /api/v1/property/export': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/property/template': [PRIVILEGE_VIEW_PROPERTY],
  
  // View properties - requires VIEW_PROPERTY privilege
  'GET /api/v1/property/properties': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/property/properties/export': [PRIVILEGE_VIEW_PROPERTY],
  'GET /api/v1/property/properties/check-name': [PRIVILEGE_VIEW_PROPERTY],
  
  // Import properties - requires CREATE_PROPERTY privilege
  'POST /api/v1/property/properties/import': [PRIVILEGE_CREATE_PROPERTY],
  
  // Property images - requires EDIT_PROPERTY privilege
  'POST /api/v1/property/properties/:id/images': [PRIVILEGE_EDIT_PROPERTY],
  'PUT /api/v1/property/properties/:id/profile-image': [PRIVILEGE_EDIT_PROPERTY],
  'DELETE /api/v1/property/properties/:id/images': [PRIVILEGE_EDIT_PROPERTY],
  
  // View property details - requires VIEW_PROPERTY privilege
  'GET /api/v1/property/properties/:id': [PRIVILEGE_VIEW_PROPERTY],
  
  // Archive property - requires EDIT_PROPERTY privilege
  'PATCH /api/v1/property/properties/:id/archive': [PRIVILEGE_EDIT_PROPERTY],
  
  // Property notes - requires EDIT_PROPERTY privilege
  'POST /api/v1/property/properties/:id/notes': [PRIVILEGE_EDIT_PROPERTY],
  'PUT /api/v1/property/properties/:id/notes/:noteId': [PRIVILEGE_EDIT_PROPERTY],
  'DELETE /api/v1/property/properties/:id/notes/:noteId': [PRIVILEGE_EDIT_PROPERTY],
  
  // Delete property - requires DELETE_PROPERTY privilege
  'DELETE /api/v1/property/properties/:id': [PRIVILEGE_DELETE_PROPERTY],
};
