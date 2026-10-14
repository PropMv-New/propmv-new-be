'use strict';

const logger = require('../../logger');
const { getBackgroundJobConfig, isBackgroundJobsEnabled } = require('../config');
const { startBullmqWorkers, stopBullmqWorkers } = require('./bullmqWorkers');
const { startMongoJobPoller, stopMongoJobPoller } = require('./mongoPoller');
const { closeQueues } = require('../queue/queues');
const { closeSharedRedisConnection } = require('../queue/redisConnection');
const { getWorkerId } = require('../job.service');

let started = false;
let shutdownBound = false;
let runtimeWorkerId = null;

async function startBackgroundJobRuntime(options = {}) {
  const config = getBackgroundJobConfig();
  if (!isBackgroundJobsEnabled()) {
    logger.info('[BackgroundJobs] Disabled via BACKGROUND_JOBS_ENABLED=false');
    return { started: false, reason: 'disabled' };
  }
  if (started && !options.force) {
    return { started: false, reason: 'already_running', workerId: runtimeWorkerId };
  }

  runtimeWorkerId = options.workerId || getWorkerId();
  const bull = await startBullmqWorkers({ workerId: runtimeWorkerId, queues: options.queues });
  startMongoJobPoller({ workerId: runtimeWorkerId, queues: options.queues, immediate: options.immediate });
  started = true;
  // Standalone workers own process signals. Embedded mode must NOT bind SIGINT/SIGTERM:
  // installing a listener replaces Node's default "exit on Ctrl+C", which orphans the
  // API process and leaves PORT in use after nodemon/npm exits.
  bindShutdownHandlers({ embedded: options.embedded === true });
  logger.info('[BackgroundJobs] Runtime started', {
    workerId: runtimeWorkerId,
    bullmq: Boolean(bull.started),
    embedded: options.embedded === true,
  });
  return { started: true, workerId: runtimeWorkerId, bullmq: bull };
}

async function stopBackgroundJobRuntime() {
  stopMongoJobPoller();
  await stopBullmqWorkers();
  await closeQueues();
  await closeSharedRedisConnection();
  started = false;
  logger.info('[BackgroundJobs] Runtime stopped', { workerId: runtimeWorkerId });
}

function bindShutdownHandlers(options = {}) {
  if (shutdownBound) return;
  if (options.embedded === true) {
    logger.info('[BackgroundJobs] Skipping signal handlers (embedded - API server owns SIGINT/SIGTERM)');
    return;
  }
  shutdownBound = true;

  const shutdown = async (signal) => {
    logger.info('[BackgroundJobs] Graceful shutdown', { signal, workerId: runtimeWorkerId });
    try {
      await stopBackgroundJobRuntime();
    } catch (err) {
      logger.error('[BackgroundJobs] Shutdown error', { error: err.message });
    }
    // Standalone worker process must always exit; default Node exit-on-SIGINT is gone once we listen.
    if (process.env.BACKGROUND_JOBS_EXIT_ON_SIGNAL !== 'false') {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

function isRuntimeStarted() {
  return started;
}

function getRuntimeWorkerId() {
  return runtimeWorkerId;
}

module.exports = {
  startBackgroundJobRuntime,
  stopBackgroundJobRuntime,
  isRuntimeStarted,
  getRuntimeWorkerId,
};
