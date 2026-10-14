/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const { apiRateLimitMiddleware } = require('./apiRateLimit.middleware');

module.exports = {
  apiRateLimitMiddleware,
};
