'use strict';

const { QUEUE_NAMES } = require('./constants');

function envInt(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseRetryDelaysMs(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback.slice();
  const parsed = String(raw)
    .split(',')
    .map((part) => Number(String(part).trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : fallback.slice();
}

const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000];

function getBackgroundJobConfig(env = process.env) {
  const isProduction =
    String(env.NODE_ENV || '').toLowerCase() === 'production' ||
    String(env.APP_PROFILE || '').toLowerCase() === 'production';

  return {
    enabled: envBool('BACKGROUND_JOBS_ENABLED', true, env),
    embeddedWorkers: envBool('BACKGROUND_WORKERS_EMBEDDED', !isProduction, env),
    redisUrl: String(env.REDIS_URL || env.BACKGROUND_JOB_REDIS_URL || '').trim(),
    prefix: String(env.BACKGROUND_JOB_QUEUE_PREFIX || 'propmv:jobs').trim() || 'propmv:jobs',
    maxAttempts: Math.max(1, envInt('BACKGROUND_JOB_MAX_ATTEMPTS', 3, env)),
    retryDelaysMs: parseRetryDelaysMs(env.BACKGROUND_JOB_RETRY_DELAYS_MS, DEFAULT_RETRY_DELAYS_MS),
    lockMs: Math.max(5_000, envInt('BACKGROUND_JOB_LOCK_MS', 120_000, env)),
    pollIntervalMs: Math.max(500, envInt('BACKGROUND_JOB_POLL_INTERVAL_MS', 3_000, env)),
    pollBatchSize: Math.max(1, envInt('BACKGROUND_JOB_POLL_BATCH_SIZE', 20, env)),
    startupDelayMs: Math.max(0, envInt('BACKGROUND_JOB_STARTUP_DELAY_MS', 8_000, env)),
    staleProcessingMs: Math.max(10_000, envInt('BACKGROUND_JOB_STALE_PROCESSING_MS', 180_000, env)),
    redisRetryAfterMs: Math.max(5_000, envInt('BACKGROUND_JOB_REDIS_RETRY_AFTER_MS', 60_000, env)),
    concurrency: {
      [QUEUE_NAMES.EMAIL]: Math.max(1, envInt('BACKGROUND_JOB_EMAIL_CONCURRENCY', 10, env)),
      [QUEUE_NAMES.NOTIFICATION]: Math.max(1, envInt('BACKGROUND_JOB_NOTIFICATION_CONCURRENCY', 10, env)),
      [QUEUE_NAMES.INVOICE]: Math.max(1, envInt('BACKGROUND_JOB_INVOICE_CONCURRENCY', 3, env)),
      [QUEUE_NAMES.MAINTENANCE]: Math.max(1, envInt('BACKGROUND_JOB_MAINTENANCE_CONCURRENCY', 5, env)),
      [QUEUE_NAMES.REPORT]: Math.max(1, envInt('BACKGROUND_JOB_REPORT_CONCURRENCY', 2, env)),
    },
  };
}

function isBackgroundJobsEnabled(env = process.env) {
  return getBackgroundJobConfig(env).enabled;
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  getBackgroundJobConfig,
  isBackgroundJobsEnabled,
  envInt,
  envBool,
  parseRetryDelaysMs,
};
