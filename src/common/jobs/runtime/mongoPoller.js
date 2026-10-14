'use strict';

const logger = require('../../logger');
const { QUEUE_NAMES } = require('../constants');
const { getBackgroundJobConfig } = require('../config');
const { getWorkerId } = require('../job.service');
const { processNextQueuedJob, markWorkersStarted } = require('./processJob');

let pollTimer = null;
let running = 0;
let workerId = null;

async function processPollBatch(options = {}) {
  const config = getBackgroundJobConfig();
  const batchSize = options.batchSize || config.pollBatchSize;
  const id = options.workerId || workerId || getWorkerId();
  const queues = options.queues || Object.values(QUEUE_NAMES);
  const concurrency = Math.max(
    1,
    ...queues.map((queue) => config.concurrency[queue] || 1)
  );

  const available = Math.max(0, concurrency - running);
  if (available === 0) return { skipped: true, reason: 'at_concurrency' };

  const toClaim = Math.min(batchSize, available);
  const tasks = [];
  for (let i = 0; i < toClaim; i += 1) {
    running += 1;
    tasks.push(
      processNextQueuedJob(id, options.queue ? { queue: options.queue } : {})
        .catch((err) => {
          logger.error('[BackgroundJobs] Poller job error', { error: err.message, workerId: id });
          return { ok: false, error: err.message };
        })
        .finally(() => {
          running = Math.max(0, running - 1);
        })
    );
  }
  const results = await Promise.all(tasks);
  return { claimed: results.filter((row) => row && !row.skipped).length, results };
}

function startMongoJobPoller(options = {}) {
  const config = getBackgroundJobConfig();
  if (pollTimer) return { started: false, reason: 'already_running' };

  workerId = options.workerId || getWorkerId();
  markWorkersStarted();

  const tick = () => {
    processPollBatch({ workerId, ...options }).catch((err) => {
      logger.error('[BackgroundJobs] Poller tick failed', { error: err.message, workerId });
    });
  };

  const start = () => {
    tick();
    pollTimer = setInterval(tick, config.pollIntervalMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    logger.info('[BackgroundJobs] Mongo poller started', {
      workerId,
      pollIntervalMs: config.pollIntervalMs,
    });
  };

  if (config.startupDelayMs > 0 && !options.immediate) {
    const startupTimer = setTimeout(start, config.startupDelayMs);
    if (typeof startupTimer.unref === 'function') startupTimer.unref();
  } else {
    start();
  }

  return { started: true, workerId };
}

function stopMongoJobPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function getPollerState() {
  return { running, workerId, active: Boolean(pollTimer) };
}

module.exports = {
  startMongoJobPoller,
  stopMongoJobPoller,
  processPollBatch,
  getPollerState,
};
