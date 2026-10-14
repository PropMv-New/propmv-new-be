'use strict';

const { claimNextJob, markJobCompleted, markJobFailed, getJobByJobId } = require('../job.service');
const { processJobByQueue } = require('../processors');
const { dispatchJob } = require('../enqueue');
const { JOB_STATUS } = require('../constants');
const logger = require('../../logger');

const workerStats = {
  startedAt: null,
  processed: 0,
  failed: 0,
  retried: 0,
  lastJobAt: null,
  lastError: '',
};

function getWorkerStats() {
  return { ...workerStats };
}

async function executeClaimedJob(job, workerId) {
  const started = Date.now();
  try {
    const result = await processJobByQueue(job);
    await markJobCompleted(job, result);
    workerStats.processed += 1;
    workerStats.lastJobAt = new Date();
    logger.info('[BackgroundJobs] Job completed', {
      jobId: job.jobId,
      jobType: job.jobType,
      durationMs: Date.now() - started,
      workerId,
    });
    return { ok: true, result };
  } catch (err) {
    const outcome = await markJobFailed(job, err, { workerId });
    workerStats.failed += 1;
    workerStats.lastError = err.message;
    workerStats.lastJobAt = new Date();
    if (outcome.retry) {
      workerStats.retried += 1;
      const refreshed = await getJobByJobId(job.jobId);
      if (refreshed) {
        await dispatchJob(refreshed).catch(() => {});
      }
    }
    return { ok: false, error: err.message, outcome };
  }
}

async function processQueuedJob(jobId, workerId, options = {}) {
  const existing = await getJobByJobId(jobId);
  if (!existing) return { skipped: true, reason: 'missing' };
  if (existing.status === JOB_STATUS.COMPLETED || existing.status === JOB_STATUS.CANCELLED) {
    return { skipped: true, reason: existing.status };
  }
  if (
    existing.status === JOB_STATUS.PROCESSING &&
    existing.lockedUntil &&
    new Date(existing.lockedUntil).getTime() > Date.now() &&
    existing.workerId &&
    existing.workerId !== workerId
  ) {
    return { skipped: true, reason: 'locked' };
  }

  const claimed = await claimNextJob(workerId, { jobId, queue: options.queue });
  if (!claimed) return { skipped: true, reason: 'not_claimable' };
  return executeClaimedJob(claimed, workerId);
}

async function processNextQueuedJob(workerId, options = {}) {
  const claimed = await claimNextJob(workerId, options);
  if (!claimed) return { skipped: true, reason: 'empty' };
  return executeClaimedJob(claimed, workerId);
}

function markWorkersStarted() {
  workerStats.startedAt = workerStats.startedAt || new Date();
}

module.exports = {
  executeClaimedJob,
  processQueuedJob,
  processNextQueuedJob,
  getWorkerStats,
  markWorkersStarted,
};
