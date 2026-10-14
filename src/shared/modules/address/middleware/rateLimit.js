/**
 * ------------------------------------------------------------------
 * File: rateLimit.js
 * Module: Src Shared Modules Address Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for rateLimit.
 *
 * Used By:
 * address.routes
 * ------------------------------------------------------------------
 */

/**
 * Lightweight in-memory rate limiter for the public address endpoints.
 * Limits/windows come from config/rateLimit.config.js (ADDRESS_* env vars).
 */
const rateLimitConfig = require('../../../../config/rateLimit.config');

function getLookupConfig() {
  return rateLimitConfig.address?.lookup || { limit: 90, windowMs: 60 * 1000 };
}

function getUsageConfig() {
  return rateLimitConfig.address?.usage || { limit: 600, windowMs: 60 * 1000 };
}

const buckets = new Map();
const usageBuckets = new Map();

/**
 * get Client Ip
 *
 * Performs logic operations for getClientIp.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

/**
 * consume
 *
 * Performs logic operations for consume.
 *
 * @param store - Request/input argument
 * @param ip - Request/input argument
 * @param max - Request/input argument
 * @returns Operations result
 */
function consume(store, ip, limit, windowMs) {
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || now - entry.start >= windowMs) {
    store.set(ip, { start: now, count: 1 });
    return true;
  }

  entry.count += 1;
  return entry.count <= limit;
}

/**
 * address Rate Limit
 *
 * Performs logic operations for addressRateLimit.
 *
 * @param req - Request/input argument
 * @param res - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function addressRateLimit(req, res, next) {
  if (!rateLimitConfig.enabled) return next();
  const { limit, windowMs } = getLookupConfig();
  if (consume(buckets, getClientIp(req), limit, windowMs)) return next();
  return res.status(429).json({ message: 'Too many address requests. Please slow down.' });
}

/**
 * address Usage Rate Limit
 *
 * Performs logic operations for addressUsageRateLimit.
 *
 * @param req - Request/input argument
 * @param res - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function addressUsageRateLimit(req, res, next) {
  if (!rateLimitConfig.enabled) return next();
  const { limit, windowMs } = getUsageConfig();
  if (consume(usageBuckets, getClientIp(req), limit, windowMs)) return next();
  return res.status(429).json({ message: 'Too many address usage reports. Please slow down.' });
}

// Periodic cleanup so the maps do not grow unbounded.
const cleanup = setInterval(() => {
  const now = Date.now();
  const lookupWindow = getLookupConfig().windowMs;
  const usageWindow = getUsageConfig().windowMs;
  for (const [ip, entry] of buckets.entries()) {
    if (now - entry.start >= lookupWindow) buckets.delete(ip);
  }
  for (const [ip, entry] of usageBuckets.entries()) {
    if (now - entry.start >= usageWindow) usageBuckets.delete(ip);
  }
}, 5 * 60 * 1000);
if (typeof cleanup.unref === 'function') {
  cleanup.unref();
}

module.exports = addressRateLimit;
module.exports.addressRateLimit = addressRateLimit;
module.exports.addressUsageRateLimit = addressUsageRateLimit;
