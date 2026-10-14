/**
 * ------------------------------------------------------------------
 * File: landlordFlowLog.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for landlordFlowLog.
 *
 * Used By:
 * auth, authorize, landlordRequestLogger.middleware, listing.service
 * ------------------------------------------------------------------
 */

/**
 * Landlord API flow logger - single source of truth for step names and messages.
 *
 * PIPELINE (every `/api/v1/landlord/*` request)
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Step 1  REQUEST_START / REQUEST_END   landlordRequestLogger.middleware  │
 * │ Step 2  AUTH_START / AUTH_OK|FAIL   middleware/auth.js                │
 * │ Step 3  AUTHORIZE_START / OK|FAIL   middleware/authorize.js           │
 * │ Step 4  HANDLER_START / END|ERROR   controller (landlordController)   │
 * │ Step 5  SERVICE_*                   service layer (per module)        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * CORRELATION
 * All steps for one HTTP request share `req.landlordRequestId` (16-char hex).
 * Filter server logs: grep the requestId from REQUEST_START to see the full trace.
 *
 * SECURITY
 * Never log request/response bodies, JWT tokens, or full MongoDB documents.
 * Only whitelisted scalar metadata is emitted (see common/logger.js SAFE_META_KEYS).
 *
 * EXTENDING TO NEW MODULES
 * 1. Import `logLandlordFlow` in your service.
 * 2. Log SERVICE_START → SERVICE_VALIDATE → SERVICE_DB_* → SERVICE_END.
 * 3. Pass `{ requestId, action }` from controller via service options.
 *
 * @see README_LANDLORD_LOGGING.md
 */
const logger = require('../../../common/logger');

/**
 * Canonical step identifiers and human-readable descriptions.
 * Custom messages may override these per call via logLandlordFlow's third argument.
 */
const STEP_MESSAGES = {
  // ── HTTP boundary ──────────────────────────────────────────────────────────
  REQUEST_START: 'Incoming landlord API request received',
  REQUEST_END: 'HTTP response sent to client',
  REQUEST_ERROR: 'Request ended with server error',

  // ── Authentication (auth.js) ─────────────────────────────────────────────
  AUTH_START: 'Validating Bearer JWT access token',
  AUTH_OK: 'JWT validated - user identity attached to request',
  AUTH_FAIL: 'Authentication rejected - missing or invalid token',

  // ── Authorization (authorize.js) ───────────────────────────────────────────
  AUTHORIZE_START: 'Checking required privileges for route',
  AUTHORIZE_OK: 'Privilege check passed - access granted',
  AUTHORIZE_FAIL: 'Privilege check failed - access denied',

  // ── Account lock (future / route-specific) ─────────────────────────────────
  LOCK_CHECK_OK: 'Account lock check passed',
  LOCK_CHECK_FAIL: 'Account is locked - request blocked',

  // ── Payload validation (route validators) ──────────────────────────────────
  VALIDATION_OK: 'Request payload validation passed',
  VALIDATION_FAIL: 'Request payload validation failed',

  // ── Controller layer ───────────────────────────────────────────────────────
  HANDLER_START: 'Controller handler started',
  HANDLER_END: 'Controller handler finished successfully',
  HANDLER_ERROR: 'Controller handler failed with error',

  // ── Service layer ─────────────────────────────────────────────────────────
  SERVICE_START: 'Service layer started processing',
  SERVICE_VALIDATE: 'Business rules validated',
  SERVICE_DB_QUERY: 'Database query executed',
  SERVICE_DB_WRITE: 'Database write committed',
  SERVICE_SYNDICATION: 'Syndication sync queued (non-blocking)',
  SERVICE_END: 'Service layer completed',
};

/**
 * Returns true when the request targets the landlord portal API.
 * Used by shared auth/authorize middleware to emit landlord-specific steps only.
 */
function isLandlordRequest(req) {
  const path = `${req.originalUrl || req.url || ''}${req.baseUrl || ''}`;
  return path.includes('/landlord');
}

/**
 * Emits one structured pipeline step to the server console.
 *
 * @param {string} step - Key from STEP_MESSAGES (stored in meta.step)
 * @param {object} [meta] - Whitelisted metadata (requestId, userId, listingId, …)
 * @param {string} [customMessage] - Optional override for the default description
 */
function logLandlordFlow(step, meta = {}, customMessage) {
  const message = customMessage || STEP_MESSAGES[step] || step;
  logger.step(step, `[LANDLORD] ${message}`, {
    layer: 'landlord',
    phase: step,
    ...meta,
  });
}

module.exports = {
  STEP_MESSAGES,
  isLandlordRequest,
  logLandlordFlow,
};
