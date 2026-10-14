/**
 * CSRF protection middleware (CWE-352/1275).
 *
 * Strategy: dual-layer validation -
 *   1. Origin/Referer header check against the configured allowed origin.
 *   2. Custom request header validation (X-Requested-With).
 * Browsers enforce CORS preflight for custom headers, so a forged cross-origin
 * request cannot set X-Requested-With without the server's explicit CORS approval.
 *
 * Applied to all state-mutating routes (POST, PUT, PATCH, DELETE).
 * Public auth endpoints (login, signup, forgot-password) are exempt because
 * they are intentionally cross-origin accessible and rely on body validation + rate limiting.
 */

const EXEMPT_PATHS = new Set([
  '/signup',
  '/login',
  '/forgot-password',
  '/send-mfa-otp',
  '/verify-mfa-otp',
  '/verify-otp-reset-password',
  '/verify-reset-otp',
  '/refresh',
  '/portal-invite/complete',
]);

// Webhook path prefixes exempt from CSRF - server-to-server calls validated by payload signature or shared secret
const EXEMPT_PREFIXES = [
  '/api/webhooks/straddle/',
  '/api/webhooks/rainforest/',
  '/api/webhooks/payload/',
  '/api/v1/system/email-bounces',
  '/api/v1/system/email-suppressions',
  '/api/v1/zillow/callback',
  '/api/v1/accounts/webhooks/',
  '/api/v1/marketing/email-subscriptions',
  '/api/v1/marketing/visits',
  '/api/v1/marketing/demo-requests',
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Returns true when the request path exactly matches one of the exempt entries
 * at a path segment boundary, preventing bypass via paths like "/evil/login".
 */
function isExempt(path) {
  const normalized = path.split('?')[0].replace(/\/$/, '');
  if (EXEMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return [...EXEMPT_PATHS].some((exempt) => {
    if (normalized === exempt) return true;
    return normalized.endsWith('/' + exempt.replace(/^\//, ''));
  });
}

const { resolveCorsOrigins } = require('../config/corsOrigins');

/**
 * Returns the allowed origins derived from env + known PropMv portals.
 */
function getAllowedOrigins() {
  return resolveCorsOrigins().origins;
}

/**
 * Middleware: reject mutating requests that lack the X-Requested-With header
 * or originate from an untrusted origin.
 */
function csrfProtection(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (isExempt(req.path)) return next();

  // Layer 1: Origin / Referer check
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.length > 0) {
    const origin = req.headers['origin'] || '';
    const referer = req.headers['referer'] || '';
    const source = origin || referer;
    if (source && !allowedOrigins.some((allowed) => source.startsWith(allowed))) {
      return res.status(403).json({ message: 'Forbidden: untrusted request origin' });
    }
  }

  // Layer 2: X-Requested-With header check
  const xrw = req.headers['x-requested-with'];
  if (!xrw || xrw.toLowerCase() !== 'xmlhttprequest') {
    return res.status(403).json({ message: 'Forbidden: missing or invalid X-Requested-With header' });
  }

  next();
}

module.exports = csrfProtection;
