/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Legacy S3 integration entry point.
 *
 * Kept for backward compatibility with existing require('.../integrations/s3') call sites.
 * All storage is now routed through the provider factory (S3 | Azure | Mock).
 *
 * Prefer requiring '../integrations/storage' in new code.
 */
module.exports = require('../storage');
