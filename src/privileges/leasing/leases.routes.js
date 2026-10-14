/**
 * ------------------------------------------------------------------
 * File: leases.routes.js
 * Module: Src Privileges Leasing
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Leasing API Privileges
 * 
 * Defines which privileges are required to access leasing endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is publicly accessible (no privilege required).
 */

const {
  PRIVILEGE_VIEW_LEASE,
  PRIVILEGE_CREATE_LEASE,
  PRIVILEGE_EDIT_LEASE,
  PRIVILEGE_DELETE_LEASE,
} = require('../../common/constants/privileges');

module.exports = {
  // Create lease - requires CREATE_LEASE privilege
  'POST /api/v1/leasing/lease': [PRIVILEGE_CREATE_LEASE],
  
  // View leases - requires VIEW_LEASE privilege
  'GET /api/v1/leasing/lease': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/list': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/tenure-availability': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/tenant': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/export': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/lease/:id': [PRIVILEGE_VIEW_LEASE],
  
  // Update lease - requires EDIT_LEASE privilege
  'PUT /api/v1/leasing/lease/:id': [PRIVILEGE_EDIT_LEASE],
  
  // Delete lease - requires DELETE_LEASE privilege
  'DELETE /api/v1/leasing/lease/:id': [PRIVILEGE_DELETE_LEASE],
  
  // Lease lifecycle operations
  'POST /api/v1/leasing/lease/:id/renew': [PRIVILEGE_EDIT_LEASE],
  'POST /api/v1/leasing/lease/:id/activate': [PRIVILEGE_EDIT_LEASE],
  
  // Lease document operations
  'POST /api/v1/leasing/lease/:id/document': [PRIVILEGE_EDIT_LEASE],
  
  // Lease termination - requires EDIT_LEASE privilege
  'PATCH /api/v1/leasing/lease/:id/terminate': [PRIVILEGE_EDIT_LEASE],
  
  // Lease notes - requires EDIT_LEASE privilege
  'POST /api/v1/leasing/lease/:id/notes': [PRIVILEGE_EDIT_LEASE],
  
  // Lease templates - requires CREATE_LEASE and EDIT_LEASE
  'POST /api/v1/leasing/creator/:createdBy/templates': [PRIVILEGE_CREATE_LEASE, PRIVILEGE_EDIT_LEASE],
  'GET /api/v1/leasing/creator/:createdBy/templates': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/templates/:templateId': [PRIVILEGE_VIEW_LEASE],
  'GET /api/v1/leasing/templates/:templateId/download': [PRIVILEGE_VIEW_LEASE],
  'PUT /api/v1/leasing/creator/:createdBy/templates/:templateId': [PRIVILEGE_EDIT_LEASE],
  'DELETE /api/v1/leasing/creator/:createdBy/templates/:templateId': [PRIVILEGE_DELETE_LEASE],
};
