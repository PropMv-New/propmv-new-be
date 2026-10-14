/**
 * ------------------------------------------------------------------
 * File: auth.routes.js
 * Module: Src Shared Privileges Auth
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for auth APIs
module.exports = {
  'POST /api/v1/auth/signup': [],
  'POST /api/v1/auth/login': [],
  'POST /api/v1/auth/forgot-password': [],
  'POST /api/v1/auth/verify-reset-otp': [],
  'PUT /api/v1/auth/verify-otp-reset-password': [],
  'GET /api/v1/auth/refresh-token': [],
  'POST /api/v1/auth/logout': [],
  'PUT /api/v1/auth/lock-account': [],
  'PUT /api/v1/auth/unlock-account': [],
  'GET /api/v1/auth/session': [],
  'PUT /api/v1/auth/reset-password': [],
};
