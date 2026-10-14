/**
 * ------------------------------------------------------------------
 * File: users.routes.js
 * Module: Src Privileges Users
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * Users API Privileges
 * 
 * Defines which privileges are required to access user management endpoints.
 * If multiple privileges are listed, user needs AT LEAST ONE of them (OR logic).
 * If the array is empty, the endpoint is auth-only (any authenticated user with ≥1 privilege).
 */

const { 
  PRIVILEGE_VIEW_USERS,
  PRIVILEGE_CREATE_USERS,
  PRIVILEGE_EDIT_USERS,
  PRIVILEGE_DELETE_USERS,
  PRIVILEGE_ASSIGN_ROLE,
} = require('../../common/constants/privileges');

module.exports = {
  // Current authenticated user profile (GET /users) - any logged-in user with privileges
  'GET /api/v1/users': [],

  // Admin user list
  'GET /api/v1/users/list': [PRIVILEGE_VIEW_USERS],
  
  // Create new user - requires CREATE_USERS privilege
  'POST /api/v1/users': [PRIVILEGE_CREATE_USERS],
  'POST /api/v1/users/batch': [PRIVILEGE_CREATE_USERS],
  
  // Assign role to users - requires ASSIGN_ROLE privilege
  'PUT /api/v1/users/role': [PRIVILEGE_ASSIGN_ROLE],
  'PUT /api/v1/users/:id/role': [PRIVILEGE_ASSIGN_ROLE],
  
  // Update own profile (self) is auth-only; editing another user is enforced in
  // userProfile.controller (requires EDIT_USERS). Empty map = any authenticated
  // user with ≥1 privilege may enter the handler.
  'PUT /api/v1/users/:id': [],
  
  // Delete user - requires DELETE_USERS privilege
  'DELETE /api/v1/users/:id': [PRIVILEGE_DELETE_USERS],
  
  // View user privileges - requires VIEW_USERS privilege
  'GET /api/v1/users/privileges/:id': [PRIVILEGE_VIEW_USERS],
  
  // Same self-or-EDIT_USERS rule as PUT /users/:id (enforced in controller)
  'PUT /api/v1/users/picture/:id': [],
  
  // Activate user - requires EDIT_USERS privilege
  'PATCH /api/v1/users/:id/activate': [PRIVILEGE_EDIT_USERS],

  'POST /api/v1/users/:id/send-invite': [PRIVILEGE_EDIT_USERS],
  
  // Get weather data - no privilege required
  'GET /api/v1/users/weather': [],
};
