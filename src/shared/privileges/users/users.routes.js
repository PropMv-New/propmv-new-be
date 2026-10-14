/**
 * ------------------------------------------------------------------
 * File: users.routes.js
 * Module: Src Shared Privileges Users
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for users APIs
module.exports = {
  'GET /api/v1/users': [],
  'PUT /api/v1/users/role': [],
  'PUT /api/v1/users/:id': [],
  'DELETE /api/v1/users/:id': [],
  'GET /api/v1/users/privileges/:id': [],
  'PUT /api/v1/users/picture/:id': [],
  'PATCH /api/v1/users/:id/activate': [],
  'GET /api/v1/users/weather': [],
};
