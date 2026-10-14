/**
 * Shared CORS / first-party portal origin resolution.
 * Used by Express cors middleware, Socket.IO, and CSRF Origin checks.
 */

const DEFAULT_PROPMV_PORTAL_ORIGINS = [
  'https://hoa.propmv.com',
  'https://landlord.propmv.com',
  'https://owner.propmv.com',
  'https://tenants.propmv.com',
  'https://www.propmv.com',
  'https://propmv.com',
  'https://app.propmv.com',
];

function isProdLikeEnv(env = process.env) {
  return (
    String(env.NODE_ENV || '').toLowerCase() === 'production' ||
    String(env.APP_PROFILE || '').toLowerCase() === 'production' ||
    String(env.APP_PROFILE || '').toLowerCase() === 'prod'
  );
}

function parseOriginList(raw) {
  return String(raw || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ origins: string[], isProdLike: boolean, allowAll: boolean }}
 */
function resolveCorsOrigins(env = process.env) {
  const fromEnv = parseOriginList(
    env.CORS_ORIGINS || env.CORS_ORIGIN || env.FRONTEND_URL || env.CLIENT_URL || ''
  );
  const isProdLike = isProdLikeEnv(env);

  // In production, always include known first-party portals so a partial
  // CORS_ORIGINS env (e.g. missing hoa.propmv.com) does not break HOA.
  const origins = isProdLike
    ? [...new Set([...DEFAULT_PROPMV_PORTAL_ORIGINS, ...fromEnv])]
    : fromEnv;

  return {
    origins,
    isProdLike,
    allowAll: origins.includes('*'),
  };
}

/**
 * @param {string | undefined} origin
 * @param {{ origins: string[], isProdLike: boolean, allowAll: boolean }} resolved
 * @returns {boolean}
 */
function isOriginAllowed(origin, resolved = resolveCorsOrigins()) {
  if (!origin) return true;
  if (resolved.allowAll) return true;
  if (resolved.origins.length === 0) {
    // Dev-friendly default; production must set CORS_ORIGINS / FRONTEND_URL
    // (or rely on DEFAULT_PROPMV_PORTAL_ORIGINS when isProdLike).
    return !resolved.isProdLike;
  }
  const normalized = String(origin).trim().replace(/\/$/, '');
  return resolved.origins.includes(normalized);
}

module.exports = {
  DEFAULT_PROPMV_PORTAL_ORIGINS,
  isProdLikeEnv,
  parseOriginList,
  resolveCorsOrigins,
  isOriginAllowed,
};
