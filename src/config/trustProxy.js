/**
 * Resolve Express `trust proxy` for reverse-proxy / CDN deployments.
 *
 * Defaults:
 * - local / development / test → false (ignore client-spoofable headers)
 * - staging / production / qa / other deployed profiles → 1 (trust one hop)
 *
 * Override with TRUST_PROXY:
 * - true | 1 | yes → true
 * - false | 0 | no → false
 * - integer → hop count (recommended: 1 behind Nginx/ALB, 2 behind CDN+proxy)
 * - IP/subnet list → passed through to Express
 */

const LOCAL_PROFILES = new Set(['local', 'development', 'dev', 'test']);

/**
 * Deployed when NODE_ENV=production or APP_PROFILE is a non-local value
 * (staging, production, qa, uat, etc.).
 */
function isDeployedLikeEnv(env = process.env) {
  const profile = String(env.APP_PROFILE || '').toLowerCase().trim();
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase().trim();

  if (nodeEnv === 'production') return true;
  if (profile && !LOCAL_PROFILES.has(profile)) return true;
  return false;
}

function isLocalLikeEnv(env = process.env) {
  return !isDeployedLikeEnv(env);
}

function parseTrustProxyEnv(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;

  const lower = value.toLowerCase();
  if (lower === 'true' || lower === 'yes') return true;
  if (lower === 'false' || lower === 'no') return false;
  if (/^\d+$/.test(value)) return Number(value);

  // Comma-separated subnet/IP list for Express
  if (value.includes(',')) {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return value;
}

/**
 * @returns {{ setting: boolean|number|string|string[], source: string, deployed: boolean }}
 */
function resolveTrustProxySetting(env = process.env) {
  const deployed = isDeployedLikeEnv(env);
  const parsed = parseTrustProxyEnv(env.TRUST_PROXY);

  if (parsed !== null) {
    return { setting: parsed, source: 'TRUST_PROXY', deployed };
  }

  if (deployed) {
    // One trusted hop is the safe default for Nginx / ALB / single proxy.
    // Set TRUST_PROXY=2 when traffic is CDN → proxy → app.
    return { setting: 1, source: 'default:deployed', deployed };
  }

  return { setting: false, source: 'default:local', deployed };
}

function applyTrustProxy(app, env = process.env, { log = console } = {}) {
  const resolved = resolveTrustProxySetting(env);
  app.set('trust proxy', resolved.setting);

  const enabled =
    resolved.setting === true ||
    (typeof resolved.setting === 'number' && resolved.setting > 0) ||
    (typeof resolved.setting === 'string' && resolved.setting !== 'false') ||
    (Array.isArray(resolved.setting) && resolved.setting.length > 0);

  log.info?.(
    `[trust-proxy] setting=${JSON.stringify(resolved.setting)} enabled=${enabled} source=${resolved.source}`
  );

  if (resolved.deployed && !enabled) {
    log.warn?.(
      '[trust-proxy] WARNING: trust proxy is disabled in a deployed environment. ' +
        'Login activity may record private/load-balancer IPs. ' +
        'Set TRUST_PROXY=1 (or true) and ensure the reverse proxy forwards ' +
        'CF-Connecting-IP / X-Forwarded-For / X-Real-IP.'
    );
  }

  if (resolved.deployed && enabled && resolved.setting === true) {
    log.info?.(
      '[trust-proxy] TRUST_PROXY=true trusts all hops. Prefer TRUST_PROXY=1 (or 2 behind CDN+proxy) to reduce X-Forwarded-For spoofing risk.'
    );
  }

  return resolved;
}

module.exports = {
  LOCAL_PROFILES,
  isLocalLikeEnv,
  isDeployedLikeEnv,
  parseTrustProxyEnv,
  resolveTrustProxySetting,
  applyTrustProxy,
};
