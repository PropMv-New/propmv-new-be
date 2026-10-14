const logger = require('../common/logger');
/**
 * Startup environment validation.
 * Fails fast in production when required secrets are missing or unsafe defaults are present.
 */

const REQUIRED_ALWAYS = ['DB_URL', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET'];

const INSECURE_DEFAULTS = new Set([
  'secret',
  'changeme',
  'change-me',
  'your-secret',
  'jwt_secret',
  'refresh_secret',
]);

function isInsecureSecret(value) {
  if (!value || typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 16) return true;
  return INSECURE_DEFAULTS.has(normalized);
}

function validateEnv(env = process.env, { isProduction } = {}) {
  const production =
    typeof isProduction === 'boolean'
      ? isProduction
      : String(env.NODE_ENV || '').toLowerCase() === 'production' ||
        String(env.APP_PROFILE || '').toLowerCase() === 'production';

  const missing = REQUIRED_ALWAYS.filter((key) => !env[key] || !String(env[key]).trim());
  const insecure = [];

  if (env.JWT_SECRET && isInsecureSecret(env.JWT_SECRET)) {
    insecure.push('JWT_SECRET');
  }
  if (env.REFRESH_TOKEN_SECRET && isInsecureSecret(env.REFRESH_TOKEN_SECRET)) {
    insecure.push('REFRESH_TOKEN_SECRET');
  }

  const errors = [];
  if (missing.length) {
    errors.push(`Missing required env: ${missing.join(', ')}`);
  }
  if (insecure.length) {
    const insecureMsg = `Insecure/default secrets: ${insecure.join(', ')}`;
    if (production) {
      errors.push(insecureMsg);
    } else {
      logger.warn(`[env] ${insecureMsg}`);
    }
  }

  // Deployed environments should trust the reverse proxy; warn (do not fail) when disabled.
  const trustRaw = env.TRUST_PROXY;
  if (
    production &&
    trustRaw != null &&
    ['false', '0', 'no'].includes(String(trustRaw).trim().toLowerCase())
  ) {
    logger.warn(
      '[env] TRUST_PROXY is disabled in production. Login activity may store private/load-balancer IPs instead of the client public IP.'
    );
  }

  if (errors.length) {
    const message = `[env] ${errors.join(' | ')}`;
    if (production) {
      throw new Error(message);
    }
    logger.warn(`⚠️ ${message}`);
  }

  return { ok: errors.length === 0, missing, insecure, production };
}

module.exports = {
  validateEnv,
  REQUIRED_ALWAYS,
};
