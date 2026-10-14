const { createClient } = require('redis');
const config = require('../config/default');
const rateLimitConfig = require('../config/rateLimit.config');
const logger = require('../common/logger');

function getOtpResendSettings() {
  const otp = rateLimitConfig.otpResend || {};
  return {
    cooldownSeconds: Array.isArray(otp.cooldownSeconds) && otp.cooldownSeconds.length
      ? otp.cooldownSeconds
      : [30, 60, 120],
    maxAttempts: otp.maxAttempts || 3,
    lockoutSeconds: otp.lockoutSeconds || 300,
    stateTtlMs: otp.stateTtlMs || 15 * 60 * 1000,
  };
}

let redisClient = null;
let usingMemoryFallback = false;

/** @type {Map<string, { state: object, expiresAt: number }>} */
const memoryStore = new Map();

class OtpResendLimitedError extends Error {
  constructor(retryAfterSeconds, meta = {}) {
    super('Too many OTP requests. Please try again later.');
    this.name = 'OtpResendLimitedError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    this.resendAvailableAt = meta.resendAvailableAt;
    this.resendCount = meta.resendCount;
    this.statusCode = 429;
  }
}

function getCooldownSeconds(resendCount) {
  const { cooldownSeconds, maxAttempts, lockoutSeconds } = getOtpResendSettings();
  if (resendCount >= maxAttempts) {
    return lockoutSeconds;
  }
  return cooldownSeconds[resendCount] ?? lockoutSeconds;
}

function buildMeta(state, now = Date.now()) {
  const resendAvailableAt = state.resendAvailableAt || now;
  return {
    resendCount: state.resendCount || 0,
    resendAvailableAt,
    retryAfterSeconds: Math.max(0, Math.ceil((resendAvailableAt - now) / 1000)),
  };
}

function pruneMemoryStore() {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt <= now) memoryStore.delete(key);
  }
}

async function readState(storageKey) {
  try {
    if (redisClient && redisClient.isOpen) {
      const raw = await redisClient.get(storageKey);
      if (!raw) return null;
      return JSON.parse(raw);
    }
    pruneMemoryStore();
    const entry = memoryStore.get(storageKey);
    if (!entry || entry.expiresAt <= Date.now()) {
      memoryStore.delete(storageKey);
      return null;
    }
    return entry.state;
  } catch (err) {
    logger.error('OTP resend limiter read failed', { error: err.message, storageKey });
    return null;
  }
}

async function writeState(storageKey, state) {
  const { stateTtlMs } = getOtpResendSettings();
  const expiresAt = Date.now() + stateTtlMs;
  try {
    if (redisClient && redisClient.isOpen) {
      await redisClient.set(storageKey, JSON.stringify(state), { PX: stateTtlMs });
      return;
    }
    memoryStore.set(storageKey, { state, expiresAt });
  } catch (err) {
    logger.error('OTP resend limiter write failed', { error: err.message, storageKey });
  }
}

function storageKey(scope, identifier) {
  const normalized = String(identifier || '').trim().toLowerCase();
  return `propmv:otp-resend:${scope}:${normalized}`;
}

async function init() {
  if (!rateLimitConfig.enabled) return;

  const redisUrl = process.env.REDIS_URL || config.redis?.url;
  if (!redisUrl) {
    usingMemoryFallback = true;
    return;
  }

  try {
    const client = createClient({
      url: redisUrl,
      socket: { reconnectStrategy: () => false, connectTimeout: 3000 },
    });
    client.on('error', () => undefined);
    await client.connect();
    redisClient = client;
    usingMemoryFallback = false;
  } catch (err) {
    redisClient = null;
    usingMemoryFallback = true;
    logger.warn('OTP resend limiter Redis unavailable - using in-memory fallback', {
      error: err.message,
    });
  }
}

/**
 * Ensure resend is allowed; resets cycle after lockout expiry.
 */
async function assertCanResend(scope, identifier) {
  if (!rateLimitConfig.enabled) return buildMeta({ resendCount: 0, resendAvailableAt: 0 });

  const key = storageKey(scope, identifier);
  const now = Date.now();
  let state = await readState(key);

  if (!state) {
    return buildMeta({ resendCount: 0, resendAvailableAt: now }, now);
  }

  if (state.resendCount >= getOtpResendSettings().maxAttempts && now >= state.resendAvailableAt) {
    state = { resendCount: 0, resendAvailableAt: now, lastOtpSentAt: now };
    await writeState(key, state);
    return buildMeta(state, now);
  }

  if (state.resendAvailableAt > now) {
    const meta = buildMeta(state, now);
    throw new OtpResendLimitedError(meta.retryAfterSeconds, meta);
  }

  return buildMeta(state, now);
}

/** Record initial OTP issuance (login, signup, forgot-password first send, payment first send). */
async function recordInitialOtpSent(scope, identifier) {
  if (!rateLimitConfig.enabled) {
    return buildMeta({ resendCount: 0, resendAvailableAt: Date.now() });
  }

  const now = Date.now();
  const state = {
    resendCount: 0,
    resendAvailableAt: now + getCooldownSeconds(0) * 1000,
    lastOtpSentAt: now,
  };
  await writeState(storageKey(scope, identifier), state);
  return buildMeta(state, now);
}

async function recordResendSent(scope, identifier) {
  if (!rateLimitConfig.enabled) {
    return buildMeta({ resendCount: 0, resendAvailableAt: Date.now() });
  }

  const key = storageKey(scope, identifier);
  const now = Date.now();
  let state = await readState(key) || { resendCount: 0 };

  if (state.resendCount >= getOtpResendSettings().maxAttempts && now >= state.resendAvailableAt) {
    state.resendCount = 0;
  }

  const nextCount = state.resendCount + 1;
  const nextState = {
    resendCount: nextCount,
    resendAvailableAt: now + getCooldownSeconds(nextCount) * 1000,
    lastOtpSentAt: now,
  };
  await writeState(key, nextState);
  return buildMeta(nextState, now);
}

async function recordOtpSent(scope, identifier, mode = 'initial') {
  if (mode === 'resend') {
    return recordResendSent(scope, identifier);
  }
  return recordInitialOtpSent(scope, identifier);
}

async function shutdown() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
}

module.exports = {
  OtpResendLimitedError,
  init,
  shutdown,
  assertCanResend,
  recordInitialOtpSent,
  recordResendSent,
  recordOtpSent,
  getOtpResendSettings,
  get OTP_MAX_RESEND_ATTEMPTS() {
    return getOtpResendSettings().maxAttempts;
  },
};
