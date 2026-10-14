/**
 * Optional mailbox existence verification via third-party APIs.
 * Catches cases MX cannot (valid domain, nonexistent local-part).
 *
 * Env:
 *   EMAIL_MAILBOX_VERIFY_ENABLED   (default false - enable when API key is set)
 *   EMAIL_MAILBOX_VERIFY_PROVIDER  zerobounce | kickbox | abstract | custom
 *   EMAIL_MAILBOX_VERIFY_API_KEY
 *   EMAIL_MAILBOX_VERIFY_URL       required for custom; may include {{email}} and {{apiKey}}
 *   EMAIL_MAILBOX_VERIFY_TIMEOUT_MS (default 5000)
 *   EMAIL_MAILBOX_VERIFY_CACHE_TTL_MS (default 86400000 = 24h)
 *   EMAIL_MAILBOX_VERIFY_ON_ERROR  allow | reject (default allow - do not block sends if API is down)
 *   EMAIL_MAILBOX_VERIFY_REJECT_CATCHALL (default false)
 */

const axios = require('axios');
const logger = require('../logger');

/** @type {Map<string, { ok: boolean, status: string, expiresAt: number, raw?: object }>} */
const verifyCache = new Map();

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envStr(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function isEnabled() {
  if (!envBool('EMAIL_MAILBOX_VERIFY_ENABLED', false)) return false;
  const provider = envStr('EMAIL_MAILBOX_VERIFY_PROVIDER').toLowerCase() || 'zerobounce';
  if (provider === 'custom') {
    return Boolean(envStr('EMAIL_MAILBOX_VERIFY_URL'));
  }
  return Boolean(envStr('EMAIL_MAILBOX_VERIFY_API_KEY'));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'operation'} timed out after ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callZeroBounce(email, apiKey, timeoutMs) {
  const url = 'https://api.zerobounce.net/v2/validate';
  const { data } = await withTimeout(
    axios.get(url, {
      params: { api_key: apiKey, email },
      timeout: timeoutMs,
      validateStatus: () => true,
    }),
    timeoutMs + 500,
    'ZeroBounce'
  );
  const status = String(data?.status || '').toLowerCase();
  const ok =
    status === 'valid' ||
    status === 'catch-all' ||
    (status === 'unknown' && !envBool('EMAIL_MAILBOX_VERIFY_REJECT_UNKNOWN', false));
  const rejectCatchAll = envBool('EMAIL_MAILBOX_VERIFY_REJECT_CATCHALL', false);
  if (rejectCatchAll && status === 'catch-all') {
    return { ok: false, status: 'catch-all', raw: data };
  }
  return { ok: Boolean(ok), status: status || 'unknown', raw: data };
}

async function callKickbox(email, apiKey, timeoutMs) {
  const url = 'https://api.kickbox.com/v2/verify';
  const { data } = await withTimeout(
    axios.get(url, {
      params: { email, apikey: apiKey },
      timeout: timeoutMs,
      validateStatus: () => true,
    }),
    timeoutMs + 500,
    'Kickbox'
  );
  const result = String(data?.result || '').toLowerCase();
  const ok =
    result === 'deliverable' ||
    (result === 'risky' && !envBool('EMAIL_MAILBOX_VERIFY_REJECT_RISKY', false)) ||
    (result === 'unknown' && !envBool('EMAIL_MAILBOX_VERIFY_REJECT_UNKNOWN', false));
  return { ok: Boolean(ok), status: result || 'unknown', raw: data };
}

async function callAbstract(email, apiKey, timeoutMs) {
  const url = 'https://emailvalidation.abstractapi.com/v1/';
  const { data } = await withTimeout(
    axios.get(url, {
      params: { api_key: apiKey, email },
      timeout: timeoutMs,
      validateStatus: () => true,
    }),
    timeoutMs + 500,
    'AbstractAPI'
  );
  const deliverability = String(data?.deliverability || '').toUpperCase();
  const ok =
    deliverability === 'DELIVERABLE' ||
    (deliverability === 'RISKY' && !envBool('EMAIL_MAILBOX_VERIFY_REJECT_RISKY', false)) ||
    (deliverability === 'UNKNOWN' && !envBool('EMAIL_MAILBOX_VERIFY_REJECT_UNKNOWN', false));
  return {
    ok: Boolean(ok),
    status: deliverability.toLowerCase() || 'unknown',
    raw: data,
  };
}

const CUSTOM_URL_ALLOWED_PROTOCOLS = ['https:'];

function assertSafeCustomUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    throw new Error('EMAIL_MAILBOX_VERIFY_URL is not a valid URL');
  }
  if (!CUSTOM_URL_ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`EMAIL_MAILBOX_VERIFY_URL must use HTTPS (got ${parsed.protocol})`);
  }
  // Block private/loopback ranges and cloud metadata endpoints
  const host = parsed.hostname.toLowerCase();
  const blocked = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,   // link-local / AWS metadata
    /^::1$/,
    /^\[::1\]$/,
    /^0\.0\.0\.0$/,
  ];
  if (blocked.some((re) => re.test(host))) {
    throw new Error(`EMAIL_MAILBOX_VERIFY_URL targets a disallowed host: ${host}`);
  }
}

async function callCustom(email, apiKey, timeoutMs) {
  const template = envStr('EMAIL_MAILBOX_VERIFY_URL');
  const url = template
    .replace(/\{\{\s*email\s*\}\}/gi, encodeURIComponent(email))
    .replace(/\{\{\s*apiKey\s*\}\}/gi, encodeURIComponent(apiKey || ''));
  assertSafeCustomUrl(url);

  const { data } = await withTimeout(
    axios.get(url, {
      timeout: timeoutMs,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      validateStatus: () => true,
    }),
    timeoutMs + 500,
    'CustomMailboxVerify'
  );

  // Accept common response shapes
  if (typeof data === 'boolean') return { ok: data, status: data ? 'valid' : 'invalid', raw: data };
  if (data && typeof data.valid === 'boolean') {
    return { ok: data.valid, status: data.status || (data.valid ? 'valid' : 'invalid'), raw: data };
  }
  if (data && typeof data.ok === 'boolean') {
    return { ok: data.ok, status: data.status || (data.ok ? 'valid' : 'invalid'), raw: data };
  }
  if (data && typeof data.deliverable === 'boolean') {
    return {
      ok: data.deliverable,
      status: data.status || (data.deliverable ? 'deliverable' : 'undeliverable'),
      raw: data,
    };
  }
  const status = String(data?.status || data?.result || data?.deliverability || '').toLowerCase();
  const ok = ['valid', 'deliverable', 'ok', 'pass'].includes(status);
  return { ok, status: status || 'unknown', raw: data };
}

/**
 * @returns {Promise<{ ok: boolean, status: string, skipped?: boolean, error?: string, provider?: string }>}
 */
async function verifyMailbox(email) {
  if (!isEnabled()) {
    return { ok: true, status: 'skipped', skipped: true };
  }

  const normalized = String(email || '').trim().toLowerCase();
  const cacheTtl = envInt('EMAIL_MAILBOX_VERIFY_CACHE_TTL_MS', 86400000);
  const cached = verifyCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: cached.ok, status: cached.status, provider: 'cache', fromCache: true };
  }

  const provider = (envStr('EMAIL_MAILBOX_VERIFY_PROVIDER') || 'zerobounce').toLowerCase();
  const apiKey = envStr('EMAIL_MAILBOX_VERIFY_API_KEY');
  const timeoutMs = envInt('EMAIL_MAILBOX_VERIFY_TIMEOUT_MS', 5000);
  const onError = String(process.env.EMAIL_MAILBOX_VERIFY_ON_ERROR || 'allow').toLowerCase();

  try {
    let result;
    if (provider === 'kickbox') {
      result = await callKickbox(normalized, apiKey, timeoutMs);
    } else if (provider === 'abstract' || provider === 'abstractapi') {
      result = await callAbstract(normalized, apiKey, timeoutMs);
    } else if (provider === 'custom') {
      result = await callCustom(normalized, apiKey, timeoutMs);
    } else {
      result = await callZeroBounce(normalized, apiKey, timeoutMs);
    }

    verifyCache.set(normalized, {
      ok: result.ok,
      status: result.status,
      expiresAt: Date.now() + cacheTtl,
      raw: result.raw,
    });

    return {
      ok: result.ok,
      status: result.status,
      provider,
      raw: result.raw,
    };
  } catch (err) {
    logger.warn(
      `[MailboxVerify] provider=${provider} failed for ${normalized}:`,
      err.message || err
    );
    if (onError === 'reject') {
      return { ok: false, status: 'error', provider, error: err.message || String(err) };
    }
    // Fail open - avoid blocking all invites when verifier is down
    return { ok: true, status: 'error_allowed', provider, error: err.message || String(err) };
  }
}

function clearMailboxVerifyCache() {
  verifyCache.clear();
}

module.exports = {
  isEnabled,
  verifyMailbox,
  clearMailboxVerifyCache,
};
