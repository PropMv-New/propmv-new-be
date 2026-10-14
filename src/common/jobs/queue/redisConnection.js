'use strict';

const IORedis = require('ioredis');
const logger = require('../../logger');
const { getBackgroundJobConfig } = require('../config');

let sharedConnection = null;
let connectPromise = null;
let unavailableUntil = 0;
let loggedUnavailable = false;

function normalizeRedisUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  // Windows often resolves "localhost" to IPv6 ::1 first, which fails if Redis
  // is bound to IPv4 only. Prefer 127.0.0.1.
  return raw.replace(/:\/\/localhost(?=[:/]|$)/i, '://127.0.0.1');
}

function isRedisAttemptCoolingDown(now = Date.now()) {
  return unavailableUntil > now;
}

function markRedisUnavailable(reason, retryAfterMs) {
  const delay = Math.max(5_000, Number(retryAfterMs) || 60_000);
  unavailableUntil = Date.now() + delay;
  if (!loggedUnavailable) {
    loggedUnavailable = true;
    logger.warn('[BackgroundJobs] Redis unavailable - using MongoDB poller until retry', {
      error: reason,
      retryAfterMs: delay,
    });
  }
}

function markRedisAvailable() {
  unavailableUntil = 0;
  loggedUnavailable = false;
}

function isRedisReady() {
  return Boolean(sharedConnection && sharedConnection.status === 'ready');
}

function createRedisConnection(options = {}) {
  const config = getBackgroundJobConfig();
  const url = normalizeRedisUrl(options.url || config.redisUrl);
  if (!url) return null;

  const connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: options.connectTimeout || 1500,
    lazyConnect: true,
    enableOfflineQueue: false,
    family: 4,
    retryStrategy: () => null,
    reconnectOnError: () => false,
  });

  connection.on('error', (err) => {
    const cfg = getBackgroundJobConfig();
    markRedisUnavailable(err.message, cfg.redisRetryAfterMs);
  });

  return connection;
}

async function getSharedRedisConnection() {
  const config = getBackgroundJobConfig();
  if (!config.redisUrl) return null;
  if (isRedisReady()) return sharedConnection;
  if (isRedisAttemptCoolingDown()) return null;
  if (connectPromise) return connectPromise;

  const connection = createRedisConnection();
  if (!connection) return null;

  connectPromise = connection.connect()
    .then(() => {
      sharedConnection = connection;
      markRedisAvailable();
      logger.info('[BackgroundJobs] Redis connected for job queues');
      return sharedConnection;
    })
    .catch((err) => {
      connectPromise = null;
      markRedisUnavailable(err.message, config.redisRetryAfterMs);
      try {
        connection.disconnect();
      } catch {
        // ignore
      }
      return null;
    });

  return connectPromise;
}

async function closeSharedRedisConnection() {
  connectPromise = null;
  unavailableUntil = 0;
  loggedUnavailable = false;
  if (!sharedConnection) return;
  try {
    await sharedConnection.quit();
  } catch {
    try {
      sharedConnection.disconnect();
    } catch {
      // ignore
    }
  }
  sharedConnection = null;
}

module.exports = {
  normalizeRedisUrl,
  isRedisAttemptCoolingDown,
  isRedisReady,
  markRedisUnavailable,
  markRedisAvailable,
  createRedisConnection,
  getSharedRedisConnection,
  closeSharedRedisConnection,
};
