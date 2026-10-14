/**
 * ------------------------------------------------------------------
 * File: rateLimit.service.js
 * Module: Backend Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * app, apiRateLimit.middleware
 * ------------------------------------------------------------------
 */

const { createClient } = require('redis');
const config = require('../config/default');
const rateLimitConfig = require('../config/rateLimit.config');
const logger = require('../common/logger');

let redisClient = null;
let usingMemoryFallback = false;

/** @type {Map<string, number[]>} */
const memoryStore = new Map();

/**
 * prune Memory Timestamps
 *
 * Performs logic operations for pruneMemoryTimestamps.
 *
 * @param timestamps - Request/input argument
 * @param windowStart - Request/input argument
 * @returns Operations result
 */
function pruneMemoryTimestamps(timestamps, windowStart) {
  let start = 0;
  while (start < timestamps.length && timestamps[start] <= windowStart) {
    start += 1;
  }
  return start > 0 ? timestamps.slice(start) : timestamps;
}

/**
 * memory Sliding Window Check
 *
 * Performs logic operations for memorySlidingWindowCheck.
 *
 * @param key - Request/input argument
 * @param limit - Request/input argument
 * @param windowMs - Request/input argument
 * @returns Operations result
 */
function memorySlidingWindowCheck(key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const existing = memoryStore.get(key) || [];
  const pruned = pruneMemoryTimestamps(existing, windowStart);

  if (pruned.length >= limit) {
    const oldest = pruned[0];
    const retryAfterMs = Math.max(0, oldest + windowMs - now);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      remaining: 0,
      current: pruned.length,
    };
  }

  pruned.push(now);
  memoryStore.set(key, pruned);
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, limit - pruned.length),
    current: pruned.length,
  };
}

async function redisSlidingWindowCheck(key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = `propmv:rl:${key}`;

  await redisClient.zRemRangeByScore(redisKey, 0, windowStart);
  const current = await redisClient.zCard(redisKey);

  if (current >= limit) {
    const oldestEntries = await redisClient.zRangeWithScores(redisKey, 0, 0);
    const oldestScore = oldestEntries.length ? Number(oldestEntries[0].score) : now;
    const retryAfterMs = Math.max(0, oldestScore + windowMs - now);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      remaining: 0,
      current,
    };
  }

  await redisClient.zAdd(redisKey, {
    score: now,
    value: `${now}:${Math.random().toString(36).slice(2, 10)}`,
  });
  await redisClient.expire(redisKey, Math.ceil(windowMs / 1000) + 1);

  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, limit - current - 1),
    current: current + 1,
  };
}

async function init() {
  if (!rateLimitConfig.enabled) {
    logger.warn('Rate limiting is disabled (RATE_LIMIT_ENABLED=false)');
    return;
  }

  const redisUrl = process.env.REDIS_URL || config.redis?.url;
  if (!redisUrl) {
    usingMemoryFallback = true;
    logger.warn('REDIS_URL not set - rate limiting uses in-memory store (not distributed)');
    return;
  }

  try {
    const client = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: () => false,
        connectTimeout: 3000,
      },
    });
    client.on('error', () => {
      // Handled during init/connect; avoid noisy reconnect loops when Redis is down.
    });
    await client.connect();
    redisClient = client;
    usingMemoryFallback = false;
    logger.info('Rate limit Redis client connected');
  } catch (err) {
    redisClient = null;
    usingMemoryFallback = true;
    logger.warn('Rate limit Redis connection failed - using in-memory fallback', {
      error: err.message,
    });
  }
}

/**
 * Sliding-window rate limit check.
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
 * @returns {Promise<{allowed: boolean, retryAfterSeconds: number, remaining: number, current: number}>}
 */
async function consume(key, limit, windowMs) {
  if (!rateLimitConfig.enabled) {
    return { allowed: true, retryAfterSeconds: 0, remaining: limit, current: 0 };
  }

  if (!key || !limit || !windowMs) {
    return { allowed: true, retryAfterSeconds: 0, remaining: limit, current: 0 };
  }

  try {
    if (redisClient && redisClient.isOpen) {
      return await redisSlidingWindowCheck(key, limit, windowMs);
    }
    return memorySlidingWindowCheck(key, limit, windowMs);
  } catch (err) {
    logger.error('Rate limit check failed', { error: err.message, key });
    return { allowed: true, retryAfterSeconds: 0, remaining: limit, current: 0 };
  }
}

async function shutdown() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * is Using Memory Fallback
 *
 * Performs logic operations for isUsingMemoryFallback.
 *
 * @returns Operations result
 */
function isUsingMemoryFallback() {
  return usingMemoryFallback;
}

module.exports = {
  init,
  consume,
  shutdown,
  isUsingMemoryFallback,
};
