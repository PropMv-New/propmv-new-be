/**
 * ------------------------------------------------------------------
 * File: masterData.routes.js
 * Module: Src Privileges Master
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

// Privileges for master data APIs (routes defined in src/modules/master/routes/masterData.routes.js)
module.exports = {
  // method-aware keys (mounted at /api/v1/master)
  'POST /api/v1/master': [],
  'GET /api/v1/master/keys': [],
  'GET /api/v1/master': [],
  'GET /api/v1/master/:id': [],
  'PUT /api/v1/master/:id': [],
  'DELETE /api/v1/master/:id': [],
};
