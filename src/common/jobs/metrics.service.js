'use strict';

const BackgroundJob = require('./models/backgroundJob.model');
const NotificationLog = require('./models/notificationLog.model');
const { JOB_STATUS } = require('./constants');
const { getBackgroundJobConfig } = require('./config');
const { getWorkerStats } = require('./runtime/processJob');
const { getPollerState } = require('./runtime/mongoPoller');
const { isRuntimeStarted, getRuntimeWorkerId } = require('./runtime');
const { ClockService } = require('../date');
const { getSharedRedisConnection, isRedisReady, isRedisAttemptCoolingDown } = require('./queue/redisConnection');

async function getJobMetrics() {
  const counts = await BackgroundJob.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(Object.values(JOB_STATUS).map((status) => [status, 0]));
  for (const row of counts) {
    byStatus[row._id] = row.count;
  }

  const typeCounts = await BackgroundJob.aggregate([
    { $group: { _id: '$jobType', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 25 },
  ]);

  return {
    total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    pending: byStatus[JOB_STATUS.PENDING] + byStatus[JOB_STATUS.SCHEDULED],
    processing: byStatus[JOB_STATUS.PROCESSING],
    completed: byStatus[JOB_STATUS.COMPLETED],
    failed: byStatus[JOB_STATUS.FAILED],
    retrying: byStatus[JOB_STATUS.RETRYING],
    permanentlyFailed: byStatus[JOB_STATUS.FAILED_PERMANENTLY],
    cancelled: byStatus[JOB_STATUS.CANCELLED],
    byStatus,
    byType: typeCounts,
    collectedAt: ClockService.now(),
  };
}

async function getEmailMetrics() {
  const [queued, sent, failed, retried] = await Promise.all([
    BackgroundJob.countDocuments({ jobType: { $regex: /^EMAIL_/ }, status: { $in: [JOB_STATUS.PENDING, JOB_STATUS.SCHEDULED] } }),
    NotificationLog.countDocuments({ channel: 'email', status: 'sent' }),
    NotificationLog.countDocuments({ channel: 'email', status: 'failed' }),
    BackgroundJob.countDocuments({ jobType: { $regex: /^EMAIL_/ }, status: JOB_STATUS.RETRYING }),
  ]);
  return { queued, sent, failed, retried };
}

async function getWorkerMetrics() {
  const config = getBackgroundJobConfig();
  let redisOk = isRedisReady();
  if (!redisOk && !isRedisAttemptCoolingDown()) {
    try {
      const connection = await getSharedRedisConnection();
      redisOk = Boolean(connection && connection.status === 'ready');
    } catch {
      redisOk = false;
    }
  }

  const pending = await BackgroundJob.countDocuments({
    status: { $in: [JOB_STATUS.PENDING, JOB_STATUS.RETRYING, JOB_STATUS.SCHEDULED] },
  });

  return {
    runtimeStarted: isRuntimeStarted(),
    workerId: getRuntimeWorkerId(),
    redis: redisOk,
    queueDepth: pending,
    concurrency: config.concurrency,
    poller: getPollerState(),
    stats: getWorkerStats(),
  };
}

async function listJobs(filters = {}, options = {}) {
  const query = {};
  if (filters.status) query.status = String(filters.status);
  if (filters.jobType) query.jobType = String(filters.jobType);
  if (filters.entityId) query.entityId = String(filters.entityId);
  if (filters.recipientId) query.recipientId = String(filters.recipientId);
  if (filters.queue) query.queue = String(filters.queue);

  const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
  const page = Math.max(1, Number(options.page) || 1);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    BackgroundJob.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    BackgroundJob.countDocuments(query),
  ]);

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  };
}

module.exports = {
  getJobMetrics,
  getEmailMetrics,
  getWorkerMetrics,
  listJobs,
};
