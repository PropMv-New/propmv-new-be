/**
 * ------------------------------------------------------------------
 * File: marketing.routes.js
 * Module: Src Privileges Marketing
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Privileges for marketing APIs (routes defined in src/modules/marketing/routes/marketing.js)
module.exports = {
  'POST /api/v1/marketing/listings': [],
  'POST /api/v1/marketing/leads': [],
  'POST /api/v1/marketing/email-subscriptions': [],
  'GET /api/v1/marketing/email-subscriptions': [],
  'GET /api/v1/marketing/email-subscriptions/export': [],
  'POST /api/v1/marketing/email-subscriptions/announce-launch': [],
  'POST /api/v1/marketing/visits': [],
  'POST /api/v1/marketing/demo-requests': [],
  'GET /api/v1/marketing/demo-requests': [],
  'GET /api/v1/marketing/visits/stats': [],
  'GET /api/v1/marketing/visits': [],
};
