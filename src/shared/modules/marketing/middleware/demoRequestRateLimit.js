const rateLimitConfig = require('../../../../config/rateLimit.config');

/**
 * Demo requests are rarer than newsletter signups - defaults use an hourly window.
 * Override via MARKETING_DEMO_REQUEST_RATE_LIMIT_PER_HOUR / _WINDOW_MINUTES.
 */
function getLimitConfig() {
  return rateLimitConfig.marketing?.demoRequest || { limit: 5, windowMs: 60 * 60 * 1000 };
}

const buckets = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function consume(ip) {
  const { limit, windowMs } = getLimitConfig();
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now - entry.start >= windowMs) {
    buckets.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

function demoRequestRateLimit(req, res, next) {
  if (!rateLimitConfig.enabled) return next();
  if (consume(getClientIp(req))) return next();
  return res
    .status(429)
    .json({ message: 'Too many demo requests. Please try again later or email support@propmv.com.' });
}

const cleanup = setInterval(() => {
  const now = Date.now();
  const windowMs = getLimitConfig().windowMs;
  for (const [ip, entry] of buckets.entries()) {
    if (now - entry.start >= windowMs) buckets.delete(ip);
  }
}, 10 * 60 * 1000);
if (typeof cleanup.unref === 'function') cleanup.unref();

module.exports = demoRequestRateLimit;
