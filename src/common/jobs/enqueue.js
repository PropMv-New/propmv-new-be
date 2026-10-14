'use strict';

const logger = require('../logger');
const { isBackgroundJobsEnabled, getBackgroundJobConfig } = require('./config');
const { createBackgroundJob, markQueued, getJobByJobId } = require('./job.service');
const { enqueueOnBullmq } = require('./queue/queues');
const { ClockService } = require('../date');

async function dispatchJob(job) {
  if (!job) return { queued: false };
  const delayMs = Math.max(0, new Date(job.scheduledAt || job.nextRetryAt || 0).getTime() - ClockService.now().getTime());
  const result = await enqueueOnBullmq(job, { delayMs });
  const backend = result.queued ? 'bullmq' : 'mongo';
  await markQueued(job, backend);
  return { ...result, backend };
}

/**
 * Create a persisted job and dispatch it to BullMQ when Redis is available.
 * Duplicate idempotency keys are returned without creating a second job.
 */
async function enqueueBackgroundJob(input = {}) {
  const { run: _run, ...jobInput } = input;
  const created = await createBackgroundJob(jobInput);
  if (created.duplicate) {
    return created;
  }
  try {
    const dispatch = await dispatchJob(created.job);
    return { ...created, dispatch };
  } catch (err) {
    logger.warn('[BackgroundJobs] Dispatch failed - poller will retry', {
      jobId: created.job?.jobId,
      error: err.message,
    });
    return { ...created, dispatch: { queued: false, backend: 'mongo', reason: err.message } };
  }
}

function enqueueBackgroundJobInBackground(input = {}) {
  setImmediate(() => {
    enqueueBackgroundJob(input).catch((err) => {
      logger.error('[BackgroundJobs] Failed to enqueue job', {
        jobType: input.jobType,
        entityId: input.entityId,
        error: err.message,
      });
    });
  });
}

/**
 * Queue a background job, or run immediately via setImmediate.
 *
 * @param {object} options
 * @param {Function} [options.run] - Fallback / inline executor
 * @param {boolean} [options.preferInline=false] - When true, always run via
 *   setImmediate (same delivery model as HOA in-app notifies). Use for emails
 *   that must go out with the matching in-app notification and must not depend
 *   on Redis/BullMQ workers being available.
 */
function enqueueOrRunInBackground({ run, preferInline = false, ...jobInput } = {}) {
  const runInline = () => {
    if (typeof run !== 'function') return;
    setImmediate(() => {
      Promise.resolve()
        .then(run)
        .catch((err) => {
          logger.error('[BackgroundJobs] Fallback execution failed', {
            jobType: jobInput.jobType,
            error: err?.message || err,
          });
        });
    });
  };

  if (!isBackgroundJobsEnabled() || preferInline) {
    runInline();
    return;
  }
  enqueueBackgroundJobInBackground(jobInput);
}

async function redispatchJob(jobId) {
  const job = await getJobByJobId(jobId);
  if (!job) return null;
  await dispatchJob(job);
  return job;
}

module.exports = {
  enqueueBackgroundJob,
  enqueueBackgroundJobInBackground,
  enqueueOrRunInBackground,
  dispatchJob,
  redispatchJob,
  isBackgroundJobsEnabled,
  getBackgroundJobConfig,
};
