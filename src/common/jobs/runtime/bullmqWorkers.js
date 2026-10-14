'use strict';

const { Worker } = require('bullmq');
const logger = require('../../logger');
const { QUEUE_NAMES } = require('../constants');
const { getBackgroundJobConfig } = require('../config');
const { getSharedRedisConnection } = require('../queue/redisConnection');
const { processQueuedJob, markWorkersStarted } = require('./processJob');
const { getWorkerId } = require('../job.service');

const workers = [];
let shuttingDown = false;

async function startBullmqWorkers(options = {}) {
  const config = getBackgroundJobConfig();
  const connection = await getSharedRedisConnection();
  if (!connection) {
    logger.info('[BackgroundJobs] BullMQ workers not started - Redis unavailable');
    return { started: false, reason: 'redis_unavailable' };
  }

  const workerId = options.workerId || getWorkerId();
  const queueNames = options.queues || Object.values(QUEUE_NAMES);

  for (const queueName of queueNames) {
    const concurrency = config.concurrency[queueName] || 1;
    const worker = new Worker(
      queueName,
      async (bullJob) => {
        if (shuttingDown) return { skipped: true, reason: 'shutting_down' };
        const jobId = bullJob?.data?.jobId || bullJob?.id;
        return processQueuedJob(jobId, workerId, { queue: queueName });
      },
      {
        connection,
        prefix: config.prefix,
        concurrency,
      }
    );

    worker.on('failed', (job, err) => {
      logger.error('[BackgroundJobs] BullMQ worker failed', {
        jobId: job?.data?.jobId || job?.id,
        error: err?.message,
        workerId,
      });
    });

    workers.push(worker);
    logger.info('[BackgroundJobs] BullMQ worker started', {
      queueName,
      concurrency,
      workerId,
    });
  }

  markWorkersStarted();
  return { started: true, workerId, queues: queueNames };
}

async function stopBullmqWorkers() {
  shuttingDown = true;
  const current = workers.splice(0, workers.length);
  await Promise.all(current.map((worker) => worker.close().catch(() => {})));
  shuttingDown = false;
}

function isBullmqShuttingDown() {
  return shuttingDown;
}

module.exports = {
  startBullmqWorkers,
  stopBullmqWorkers,
  isBullmqShuttingDown,
};
