'use strict';

const { Queue } = require('bullmq');
const logger = require('../../logger');
const { QUEUE_NAMES } = require('../constants');
const { getBackgroundJobConfig } = require('../config');
const { getSharedRedisConnection, isRedisReady, isRedisAttemptCoolingDown } = require('./redisConnection');

const queues = new Map();

async function getQueue(queueName) {
  const name = queueName || QUEUE_NAMES.EMAIL;
  if (queues.has(name)) return queues.get(name);

  const connection = await getSharedRedisConnection();
  if (!connection) return null;

  const config = getBackgroundJobConfig();
  const queue = new Queue(name, {
    connection,
    prefix: config.prefix,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 2000 },
    },
  });
  queues.set(name, queue);
  return queue;
}

async function enqueueOnBullmq(job, options = {}) {
  if (isRedisAttemptCoolingDown() && !isRedisReady()) {
    return { queued: false, reason: 'redis_unavailable' };
  }

  const queue = await getQueue(job.queue);
  if (!queue) return { queued: false, reason: 'redis_unavailable' };

  const delay = Math.max(0, Number(options.delayMs) || 0);
  try {
    await queue.add(
      job.jobType,
      { jobId: job.jobId },
      {
        jobId: job.jobId,
        delay,
        priority: Number(job.priority) || 5,
      }
    );
    return { queued: true, backend: 'bullmq' };
  } catch (err) {
    if (String(err.message || '').includes('Job is already')) {
      return { queued: true, backend: 'bullmq', duplicate: true };
    }
    logger.warn('[BackgroundJobs] BullMQ enqueue failed', {
      jobId: job.jobId,
      jobType: job.jobType,
      error: err.message,
    });
    return { queued: false, reason: err.message };
  }
}

async function closeQueues() {
  const entries = [...queues.values()];
  queues.clear();
  await Promise.all(entries.map((queue) => queue.close().catch(() => {})));
}

module.exports = {
  getQueue,
  enqueueOnBullmq,
  closeQueues,
};
