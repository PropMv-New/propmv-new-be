/**
 * ------------------------------------------------------------------
 * File: perfTimings.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for perfTimings.
 *
 * Used By:
 * hoaApiResponseTiming, hoaDataIsolation, dashboard.service
 * ------------------------------------------------------------------
 */

/**
 * Lightweight per-request performance marks (optional breakdown in API logs).
 */
function ensurePerfTimings(req) {
  if (!req.perfTimings) {
    req.perfTimings = {};
  }
  return req.perfTimings;
}

/**
 * mark Perf
 *
 * Performs logic operations for markPerf.
 *
 * @param req - Request/input argument
 * @param label - Request/input argument
 * @param ms - Request/input argument
 * @returns Operations result
 */
function markPerf(req, label, ms) {
  if (!req || !label) return;
  ensurePerfTimings(req)[label] = ms;
}

/**
 * mark Perf Start
 *
 * Performs logic operations for markPerfStart.
 *
 * @param req - Request/input argument
 * @param label - Request/input argument
 * @returns Operations result
 */
function markPerfStart(req, label) {
  const start = Date.now();
  return () => markPerf(req, label, Date.now() - start);
}

/**
 * format Perf Timings
 *
 * Performs logic operations for formatPerfTimings.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function formatPerfTimings(req) {
  const timings = req?.perfTimings;
  if (!timings || !Object.keys(timings).length) return '';
  return Object.entries(timings)
    .map(([k, v]) => `${k}=${v}ms`)
    .join(' ');
}

module.exports = {
  ensurePerfTimings,
  markPerf,
  markPerfStart,
  formatPerfTimings,
};
