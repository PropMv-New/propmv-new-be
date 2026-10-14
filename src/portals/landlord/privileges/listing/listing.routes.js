/**
 * ------------------------------------------------------------------
 * File: listing.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for listing APIs
const { PRIVILEGE_VIEW_LISTINGS, PRIVILEGE_CREATE_LISTINGS, PRIVILEGE_EDIT_LISTINGS, PRIVILEGE_DELETE_LISTINGS } = require('../../../../common/constants/privileges');

module.exports = {
  // Core CRUD operations for listings
  'POST /api/v1/listing/listings': [PRIVILEGE_CREATE_LISTINGS],
  'GET /api/v1/listing/listings': [PRIVILEGE_VIEW_LISTINGS],
  'GET /api/v1/listing/listings/:id': [PRIVILEGE_VIEW_LISTINGS],
  'PUT /api/v1/listing/listings/:id': [PRIVILEGE_EDIT_LISTINGS],
  'DELETE /api/v1/listing/listings/:id': [PRIVILEGE_DELETE_LISTINGS],

  // Listing status and lifecycle operations
  'PUT /api/v1/listing/listings/:id/publish': [PRIVILEGE_EDIT_LISTINGS],
  'PUT /api/v1/listing/listings/:id/activate': [PRIVILEGE_EDIT_LISTINGS],
  'PUT /api/v1/listing/listings/:id/inactive': [PRIVILEGE_EDIT_LISTINGS],
  'PUT /api/v1/listing/listings/:id/publish-from-inactive': [PRIVILEGE_EDIT_LISTINGS],

  // Image management for listings
  'POST /api/v1/listing/listings/:id/images': [PRIVILEGE_EDIT_LISTINGS],
};
