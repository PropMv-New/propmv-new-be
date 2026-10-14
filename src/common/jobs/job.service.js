'use strict';

const os = require('os');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const BackgroundJob = require('./models/backgroundJob.model');
const { JOB_STATUS, queueForJobType, PRIORITY } = require('./constants');
const { getBackgroundJobConfig } = require('./config');
const { getRetryDelayMs, isPermanentError } = require('./retry');
const { sanitizeJobPayload } = require('./sanitizePayload');
const { buildJobIdempotencyKey } = require('./idempotency');
const { ClockService, DateUtil } = require('../date');
const logger = require('../logger');

function getWorkerId() {
  return `${os.hostname()}-${process.pid}-${uuidv4().slice(0, 8)}`;
}

function serializeJob(doc) {
  if (!doc) return null;
  return typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

function assertMongoReady() {
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('MongoDB is not connected');
    err.code = 'MONGO_NOT_CONNECTED';
    throw err;
  }
}

async function findByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  assertMongoReady();
  return BackgroundJob.findOne({ idempotencyKey: String(idempotencyKey) }).lean();
}

function buildClaimableQuery(now = ClockService.now()) {
  return {
    $or: [
      {
        status: { $in: [JOB_STATUS.PENDING, JOB_STATUS.RETRYING, JOB_STATUS.SCHEDULED] },
        nextRetryAt: { $lte: now },
        scheduledAt: { $lte: now },
      },
      {
        status: JOB_STATUS.PROCESSING,
        lockedUntil: { $lt: now },
      },
    ],
  };
}

/**
 * Persist a background job. Duplicate idempotency keys return the existing job.
 */
async function createBackgroundJob(input = {}) {
  assertMongoReady();
  const config = getBackgroundJobConfig();
  const jobType = String(input.jobType || '').trim();
  if (!jobType) {
    const err = new Error('jobType is required');
    err.permanent = true;
    throw err;
  }

  const idempotencyKey = input.idempotencyKey
    ? String(input.idempotencyKey).slice(0, 300)
    : buildJobIdempotencyKey(jobType, input.entityId, input.eventId, input.recipientId);

  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { created: false, duplicate: true, job: existing };
    }
  }

  const scheduledAt = input.scheduledAt ? DateUtil.toUTC(input.scheduledAt) || ClockService.now() : ClockService.now();
  const now = ClockService.now();
  const isFuture = scheduledAt.getTime() > now.getTime();
  const jobId = input.jobId || uuidv4();

  try {
    const created = await BackgroundJob.create({
      jobId,
      idempotencyKey: idempotencyKey || null,
      jobType,
      queue: input.queue || queueForJobType(jobType),
      entityType: input.entityType ? String(input.entityType) : '',
      entityId: input.entityId != null ? String(input.entityId) : '',
      eventId: input.eventId != null ? String(input.eventId) : '',
      recipientType: input.recipientType ? String(input.recipientType) : '',
      recipientId: input.recipientId != null ? String(input.recipientId) : '',
      status: isFuture ? JOB_STATUS.SCHEDULED : JOB_STATUS.PENDING,
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : PRIORITY.NORMAL,
      attempts: 0,
      maxAttempts: Number(input.maxAttempts) || config.maxAttempts,
      scheduledAt,
      nextRetryAt: scheduledAt,
      payload: sanitizeJobPayload(input.payload || {}),
      queueBackend: '',
    });
    return { created: true, duplicate: false, job: serializeJob(created) };
  } catch (err) {
    if (err && err.code === 11000 && idempotencyKey) {
      const existing = await findByIdempotencyKey(idempotencyKey);
      if (existing) return { created: false, duplicate: true, job: existing };
    }
    throw err;
  }
}

async function markQueued(job, backend) {
  if (!job?._id) return;
  await BackgroundJob.updateOne(
    { _id: job._id, jobId: job.jobId },
    { $set: { queueBackend: backend || 'mongo' } }
  );
}

async function claimNextJob(workerId, options = {}) {
  assertMongoReady();
  const now = ClockService.now();
  const config = getBackgroundJobConfig();
  const query = buildClaimableQuery(now);
  if (options.queue) query.queue = options.queue;
  if (options.jobId) {
    query.jobId = String(options.jobId);
  }

  const lockedUntil = DateUtil.fromEpoch(ClockService.nowEpoch() + (options.lockMs || config.lockMs));

  return BackgroundJob.findOneAndUpdate(
    query,
    {
      $set: {
        status: JOB_STATUS.PROCESSING,
        workerId: workerId || getWorkerId(),
        startedAt: now,
        lockedAt: now,
        lockedUntil,
      },
    },
    {
      sort: { priority: 1, nextRetryAt: 1, createdAt: 1 },
      new: true,
    }
  ).lean();
}

async function markJobCompleted(job, result = null) {
  const now = ClockService.now();
  const started = job.startedAt ? new Date(job.startedAt).getTime() : now.getTime();
  await BackgroundJob.updateOne(
    { _id: job._id, jobId: job.jobId },
    {
      $set: {
        status: JOB_STATUS.COMPLETED,
        completedAt: now,
        failedAt: null,
        errorMessage: '',
        result: sanitizeJobPayload(result),
        lockedUntil: null,
        lockedAt: null,
        processingTimeMs: Math.max(0, now.getTime() - started),
      },
    }
  );
}

async function markJobFailed(job, err, options = {}) {
  const config = getBackgroundJobConfig();
  const attempts = (job.attempts || 0) + 1;
  const maxAttempts = job.maxAttempts || config.maxAttempts;
  const message = String(err?.message || err || 'Unknown worker error').slice(0, 2000);
  const stack = String(err?.stack || '').slice(0, 4000);
  const permanent = options.permanent === true || isPermanentError(err);
  const now = ClockService.now();
  const errorEntry = {
    at: now,
    attempt: attempts,
    message,
    stack,
    workerId: job.workerId || options.workerId || '',
  };

  if (permanent || attempts >= maxAttempts) {
    await BackgroundJob.updateOne(
      { _id: job._id, jobId: job.jobId },
      {
        $set: {
          status: JOB_STATUS.FAILED_PERMANENTLY,
          attempts,
          failedAt: now,
          errorMessage: message,
          lockedUntil: null,
          lockedAt: null,
        },
        $push: { errorHistory: errorEntry },
      }
    );
    logger.error('[BackgroundJobs] Permanent failure', {
      jobId: job.jobId,
      jobType: job.jobType,
      entityId: job.entityId,
      attempts,
      error: message,
      workerId: job.workerId,
    });
    return { permanent: true, attempts, retry: false };
  }

  const delayMs = getRetryDelayMs(attempts, config.retryDelaysMs);
  const nextRetryAt = DateUtil.fromEpoch(ClockService.nowEpoch() + delayMs);
  await BackgroundJob.updateOne(
    { _id: job._id, jobId: job.jobId },
    {
      $set: {
        status: JOB_STATUS.RETRYING,
        attempts,
        failedAt: now,
        nextRetryAt,
        errorMessage: message,
        lockedUntil: null,
        lockedAt: null,
      },
      $push: { errorHistory: errorEntry },
    }
  );
  logger.warn('[BackgroundJobs] Scheduled retry', {
    jobId: job.jobId,
    jobType: job.jobType,
    attempts,
    error: message,
  });
  return { permanent: false, attempts, retry: true, delayMs, nextRetryAt };
}

async function cancelJob(jobId) {
  const job = await BackgroundJob.findOne({ jobId: String(jobId) }).lean();
  if (!job) return null;
  if ([JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)) return job;
  await BackgroundJob.updateOne(
    { jobId: String(jobId), status: { $nin: [JOB_STATUS.COMPLETED] } },
    {
      $set: {
        status: JOB_STATUS.CANCELLED,
        lockedUntil: null,
        lockedAt: null,
      },
    }
  );
  return BackgroundJob.findOne({ jobId: String(jobId) }).lean();
}

async function retryPermanentJob(jobId) {
  const job = await BackgroundJob.findOne({ jobId: String(jobId) }).lean();
  if (!job) {
    const err = new Error('Job not found');
    err.status = 404;
    throw err;
  }
  if (job.status !== JOB_STATUS.FAILED_PERMANENTLY && job.status !== JOB_STATUS.FAILED) {
    const err = new Error('Only failed jobs can be retried');
    err.status = 400;
    throw err;
  }
  await BackgroundJob.updateOne(
    { jobId: String(jobId) },
    {
      $set: {
        status: JOB_STATUS.PENDING,
        attempts: 0,
        nextRetryAt: ClockService.now(),
        scheduledAt: ClockService.now(),
        errorMessage: '',
        lockedUntil: null,
        lockedAt: null,
        workerId: '',
      },
    }
  );
  return BackgroundJob.findOne({ jobId: String(jobId) }).lean();
}

async function getJobByJobId(jobId) {
  if (!jobId) return null;
  return BackgroundJob.findOne({ jobId: String(jobId) }).lean();
}

module.exports = {
  getWorkerId,
  createBackgroundJob,
  findByIdempotencyKey,
  buildClaimableQuery,
  claimNextJob,
  markQueued,
  markJobCompleted,
  markJobFailed,
  cancelJob,
  retryPermanentJob,
  getJobByJobId,
};
