/**
 * ------------------------------------------------------------------
 * File: landlordRequestLogger.middleware.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Express middleware providing request timing, rate limiting, logging, or authentication filters.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

/**
 * Landlord request tracing middleware - Step 1 of the API pipeline.
 *
 * MOUNT ORDER (critical)
 * Registered in app.js as the FIRST middleware on `/api/v1/landlord`:
 *   app.use('/api/v1/landlord', landlordRequestLoggerMiddleware, …, landlordRouter)
 *
 * RESPONSIBILITIES
 * 1. Assign a unique `req.landlordRequestId` for correlating all downstream steps.
 * 2. Log REQUEST_START immediately when the request enters the landlord router.
 * 3. Log REQUEST_END (or REQUEST_ERROR) when the HTTP response is fully sent.
 *
 * WHAT GETS LOGGED
 * - method, path (query string stripped), module segment, statusCode, durationMs
 * - Never: headers, body, cookies, or JWT
 *
 * DOWNSTREAM USAGE
 * Controllers and services should pass `req.landlordRequestId` in service options
 * so SERVICE_* steps appear in the same trace.
 */
const crypto = require('crypto');
const { logLandlordFlow } = require('../utils/landlordFlowLog');

/**
 * landlord Request Logger Middleware
 *
 * Performs logic operations for landlordRequestLoggerMiddleware.
 *
 * @param req - Request/input argument
 * @param res - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function landlordRequestLoggerMiddleware(req, res, next) {
  const requestId = crypto.randomBytes(8).toString('hex');
  const startedAt = process.hrtime.bigint();

  req.landlordRequestId = requestId;

  const routePath = req.originalUrl || req.url || '';
  const moduleMatch = routePath.match(/\/landlord\/([^/?]+)/);
  const module = moduleMatch ? moduleMatch[1] : 'landlord';

  logLandlordFlow('REQUEST_START', {
    requestId,
    module,
    method: req.method,
    path: truncatePath(routePath),
  });

  // Fires once when Express finishes writing the response - includes 4xx/5xx.
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

    const meta = {
      requestId,
      module,
      method: req.method,
      path: truncatePath(routePath),
      statusCode: res.statusCode,
      durationMs,
      success: res.statusCode < 400,
    };

    if (res.statusCode >= 500) {
      logLandlordFlow('REQUEST_ERROR', meta, 'Request failed - server error response sent');
    } else if (res.statusCode >= 400) {
      logLandlordFlow('REQUEST_END', meta, `Request completed - client error ${res.statusCode}`);
    } else {
      logLandlordFlow('REQUEST_END', meta);
    }
  });

  next();
}

/** Prevents oversized paths from bloating log lines; strips query strings. */
function truncatePath(path, maxLen = 200) {
  const withoutQuery = String(path).split('?')[0];
  return withoutQuery.length > maxLen ? `${withoutQuery.slice(0, maxLen)}…` : withoutQuery;
}

module.exports = { landlordRequestLoggerMiddleware };
