/**
 * ------------------------------------------------------------------
 * File: queryProfiler.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for queryProfiler.
 *
 * Used By:
 * db.config, expense.service
 * ------------------------------------------------------------------
 */

/**
 * Lightweight Mongo/API query timing helper.
 * Enable with QUERY_PROFILER=1 or SLOW_QUERY_MS=500 (default threshold 500ms).
 */

const mongoose = require('mongoose');
const logger = require('../logger');

const SLOW_MS = Number(process.env.SLOW_QUERY_MS || 500);
const ENABLED = process.env.QUERY_PROFILER === '1' || process.env.SLOW_QUERY_MS;
let mongoosePluginInstalled = false;

async function timedQuery(label, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - start;
    if (ENABLED && elapsed >= SLOW_MS) {
      logger.warn(`[SLOW QUERY] ${label}: ${elapsed}ms`, { durationMs: elapsed });
    } else if (process.env.QUERY_PROFILER === '1') {
      logger.debug(`[QUERY] ${label}: ${elapsed}ms`, { durationMs: elapsed });
    }
  }
}

/**
 * timed Section
 *
 * Performs logic operations for timedSection.
 *
 * @param label - Request/input argument
 * @returns Operations result
 */
function timedSection(label) {
  const start = Date.now();
  return () => {
    const elapsed = Date.now() - start;
    if (ENABLED && elapsed >= SLOW_MS) {
      logger.warn(`[SLOW SECTION] ${label}: ${elapsed}ms`, { durationMs: elapsed });
    } else if (process.env.QUERY_PROFILER === '1') {
      logger.debug(`[SECTION] ${label}: ${elapsed}ms`, { durationMs: elapsed });
    }
  };
}

/**
 * format Mongoose Op
 *
 * Performs logic operations for formatMongooseOp.
 *
 * @param query - Request/input argument
 * @returns Operations result
 */
function formatMongooseOp(query) {
  const filter = query.getFilter ? query.getFilter() : {};
  const op = query.op || 'query';
  const model = query.model?.modelName || 'Unknown';
  return `${model}.${op}(${JSON.stringify(filter).slice(0, 120)})`;
}

/**
 * install Mongoose Query Profiler
 *
 * Performs logic operations for installMongooseQueryProfiler.
 *
 * @returns Operations result
 */
function installMongooseQueryProfiler() {
  if (mongoosePluginInstalled || !ENABLED) return;
  mongoosePluginInstalled = true;

  mongoose.plugin((schema) => {
    schema.pre(/^find|^count|^update|^delete|^aggregate/, function mongooseQueryProfilerPre() {
      this._profilerStart = Date.now();
      this._profilerLabel = formatMongooseOp(this);
    });

    schema.post(/^find|^count|^update|^delete|^aggregate/, function mongooseQueryProfilerPost() {
      const elapsed = Date.now() - (this._profilerStart || Date.now());
      const label = this._profilerLabel || formatMongooseOp(this);
      if (elapsed >= SLOW_MS) {
        logger.warn(`[SLOW MONGO] ${label}: ${elapsed}ms`, { durationMs: elapsed });
      } else if (process.env.QUERY_PROFILER === '1') {
        logger.debug(`[MONGO] ${label}: ${elapsed}ms`, { durationMs: elapsed });
      }
    });
  });

  logger.info(`[QUERY_PROFILER] Mongoose query timing enabled`, { durationMs: SLOW_MS });
}

module.exports = {
  timedQuery,
  timedSection,
  installMongooseQueryProfiler,
  SLOW_MS,
  ENABLED,
};
