/**
 * Universal HTTP request/response logger - covers ALL portals and shared APIs.
 *
 * WHAT IT LOGS
 * - [HTTP] Incoming request  → method, path (no query string), portal segment, requestId, ip
 * - [HTTP] Response sent     → same fields + statusCode, durationMs
 *
 * WHAT IT NEVER LOGS
 * - Request/response bodies, query strings, headers, cookies, JWT tokens
 *
 * CORRELATION
 * - Assigns req.requestId (16-char hex) to every request that doesn't already have one.
 * - Landlord requests already have req.landlordRequestId from landlordRequestLogger.middleware;
 *   this middleware reuses that value so all log lines share the same ID.
 *
 * MOUNT ORDER (app.js)
 * Must be mounted BEFORE portal routers but AFTER body parsers and helmet.
 * The landlordRequestLogger middleware is mounted on the landlord sub-router and
 * runs after this one - both IDs will match for landlord requests.
 *
 * LOG LEVELS
 * - 5xx responses → error
 * - 4xx responses → warn
 * - 2xx/3xx       → info
 */
const crypto = require('crypto');
const logger = require('../common/logger');

/** Extract the top-level portal segment from a URL path (e.g. /api/v1/landlord/... → 'landlord'). */
function resolvePortal(path) {
  const m = String(path || '').match(/\/api\/v\d+\/([^/?]+)/);
  return m ? m[1] : 'api';
}

/** Strip query string and truncate to prevent oversized log lines. */
function sanitizePath(rawPath, maxLen = 200) {
  const withoutQuery = String(rawPath || '').split('?')[0];
  return withoutQuery.length > maxLen ? `${withoutQuery.slice(0, maxLen)}…` : withoutQuery;
}

/** Best-effort client IP extraction (works behind proxies when trust proxy is set). */
function resolveIp(req) {
  return (
    req.ip ||
    (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
    (req.connection && req.connection.remoteAddress) ||
    null
  );
}

function httpLoggerMiddleware(req, res, next) {
  // Reuse landlord requestId if already assigned; otherwise generate a new one.
  if (!req.requestId) {
    req.requestId = req.landlordRequestId || crypto.randomBytes(8).toString('hex');
  }

  const startedAt = process.hrtime.bigint();
  const httpMethod = req.method;
  const httpPath = sanitizePath(req.originalUrl || req.url);
  const portal = resolvePortal(httpPath);
  const ip = resolveIp(req);

  logger.httpRequest({
    requestId: req.requestId,
    httpMethod,
    httpPath,
    portal,
    ip,
  });

  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    logger.httpResponse({
      requestId: req.requestId,
      httpMethod,
      httpPath,
      httpStatus: res.statusCode,
      durationMs,
      portal,
      userId: req.userId || null,
    });
  });

  next();
}

module.exports = { httpLoggerMiddleware };
