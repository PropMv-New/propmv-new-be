/**
 * ------------------------------------------------------------------
 * File: requestTiming.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for requestTiming.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

/**
 * Logs slow API requests. Enable with REQUEST_PROFILER=1 or SLOW_REQUEST_MS (default 500).
 */
const logger = require('../common/logger');
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 500);
const ENABLED = process.env.REQUEST_PROFILER === '1' || process.env.SLOW_REQUEST_MS;

/**
 * request Timing Middleware
 *
 * Performs logic operations for requestTimingMiddleware.
 *
 * @param req - Request/input argument
 * @param res - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function requestTimingMiddleware(req, res, next) {
  if (!ENABLED) return next();

  const start = process.hrtime.bigint();
  const path = `${req.method} ${req.originalUrl || req.url}`;

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (elapsedMs >= SLOW_MS) {
      logger.warn(`[SLOW REQUEST] ${path} ${res.statusCode} ${elapsedMs.toFixed(1)}ms`, { durationMs: elapsedMs });
    } else if (process.env.REQUEST_PROFILER === '1') {
      logger.debug(`[REQUEST] ${path} ${res.statusCode} ${elapsedMs.toFixed(1)}ms`, { durationMs: elapsedMs });
    }
  });

  next();
}

module.exports = { requestTimingMiddleware, SLOW_MS };
