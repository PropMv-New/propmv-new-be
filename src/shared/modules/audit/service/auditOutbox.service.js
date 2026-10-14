'use strict';

const { v4: uuidv4 } = require('uuid');
const AuditOutbox = require('../model/auditOutbox.model');
const { OUTBOX_STATUS } = require('../model/auditOutbox.model');
const { ClockService, DateUtil } = require('../../../../common/date');
const logger = require('../../../../common/logger');
const { buildAuditIdempotencyKey } = require('../utils/auditIdempotency.util');

const DEFAULT_MAX_RETRIES = Number(process.env.AUDIT_OUTBOX_MAX_RETRIES) || 10;
const LOCK_DURATION_MS = Number(process.env.AUDIT_OUTBOX_LOCK_MS) || 60_000;
const BASE_RETRY_MS = Number(process.env.AUDIT_OUTBOX_BASE_RETRY_MS) || 5_000;
const MAX_RETRY_MS = Number(process.env.AUDIT_OUTBOX_MAX_RETRY_MS) || 300_000;

function computeAuditRetryDelayMs(retryCount) {
  const attempt = Math.max(1, Number(retryCount) || 1);
  const delay = BASE_RETRY_MS * Math.pow(2, attempt - 1);
  return Math.min(MAX_RETRY_MS, delay);
}

function buildClaimableOutboxQuery(now = ClockService.now()) {
  return {
    $or: [
      {
        status: OUTBOX_STATUS.PENDING,
        nextRetryAt: { $lte: now },
      },
      {
        status: OUTBOX_STATUS.PROCESSING,
        lockedUntil: { $lt: now },
      },
    ],
  };
}

function getWorkerId() {
  return `${process.pid}-${uuidv4().slice(0, 8)}`;
}

async function findOutboxByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  return AuditOutbox.findOne({ idempotencyKey: String(idempotencyKey) }).lean();
}

/**
 * Persist an audit event to the outbox for reliable delivery to AuditLog.
 */
async function enqueueAuditEvent(prepared = {}, options = {}) {
  const idempotencyKey = buildAuditIdempotencyKey(prepared, options.idempotencyKey || '');
  const eventId = options.eventId || uuidv4();

  if (idempotencyKey) {
    const existing = await findOutboxByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
  }

  try {
    const created = await AuditOutbox.create({
      eventId,
      idempotencyKey: idempotencyKey || null,
      payload: prepared,
      status: OUTBOX_STATUS.PENDING,
      retryCount: 0,
      maxRetries: options.maxRetries || DEFAULT_MAX_RETRIES,
      nextRetryAt: ClockService.now(),
    });
    return created.toObject();
  } catch (err) {
    if (err && err.code === 11000 && idempotencyKey) {
      const existing = await findOutboxByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Atomically claim the next deliverable outbox event (supports stale lock reclaim).
 */
async function claimNextAuditOutboxEvent(workerId = getWorkerId()) {
  const now = ClockService.now();
  const claimQuery = buildClaimableOutboxQuery(now);

  return AuditOutbox.findOneAndUpdate(
    claimQuery,
    {
      $set: {
        status: OUTBOX_STATUS.PROCESSING,
        lockedAt: now,
        lockedBy: workerId,
        lockedUntil: DateUtil.fromEpoch(ClockService.nowEpoch() + LOCK_DURATION_MS),
      },
    },
    {
      sort: { nextRetryAt: 1, createdAt: 1 },
      new: true,
    }
  ).lean();
}

async function markOutboxCompleted(outbox, auditLogRecord) {
  await AuditOutbox.updateOne(
    { _id: outbox._id, eventId: outbox.eventId },
    {
      $set: {
        status: OUTBOX_STATUS.COMPLETED,
        auditLogId: auditLogRecord?._id || null,
        processedAt: ClockService.now(),
        lastError: '',
        lockedUntil: null,
        lockedBy: '',
      },
    }
  );
}

async function markOutboxFailed(outbox, err) {
  const retryCount = (outbox.retryCount || 0) + 1;
  const maxRetries = outbox.maxRetries || DEFAULT_MAX_RETRIES;
  const message = String(err?.message || err || 'Unknown audit delivery error');
  const errorEntry = { at: ClockService.now(), message, code: String(err?.code || '') };

  if (retryCount >= maxRetries) {
    await AuditOutbox.updateOne(
      { _id: outbox._id, eventId: outbox.eventId },
      {
        $set: {
          status: OUTBOX_STATUS.FAILED,
          retryCount,
          lastError: message,
          lockedUntil: null,
          lockedBy: '',
        },
        $push: { errorHistory: errorEntry },
      }
    );
    logger.error('[AuditOutbox] Permanent delivery failure', {
      eventId: outbox.eventId,
      idempotencyKey: outbox.idempotencyKey || '',
      module: outbox.payload?.module || '',
      event: outbox.payload?.event || '',
      requestId: outbox.payload?.requestId || '',
      correlationId: outbox.payload?.correlationId || '',
      retryCount,
      error: message,
    });
    return { permanent: true, retryCount };
  }

  const delayMs = computeAuditRetryDelayMs(retryCount);
  await AuditOutbox.updateOne(
    { _id: outbox._id, eventId: outbox.eventId },
    {
      $set: {
        status: OUTBOX_STATUS.PENDING,
        retryCount,
        nextRetryAt: DateUtil.fromEpoch(ClockService.nowEpoch() + delayMs),
        lastError: message,
        lockedUntil: null,
        lockedBy: '',
      },
      $push: { errorHistory: errorEntry },
    }
  );
  logger.warn('[AuditOutbox] Delivery failed - scheduled retry', {
    eventId: outbox.eventId,
    module: outbox.payload?.module || '',
    event: outbox.payload?.event || '',
    retryCount,
    nextRetryMs: delayMs,
    error: message,
  });
  return { permanent: false, retryCount, nextRetryMs: delayMs };
}

/**
 * Deliver one claimed outbox row to AuditLog (idempotent via auditEventId).
 */
async function deliverOutboxEvent(outbox, { createAuditLog }) {
  if (!outbox || !outbox.eventId) {
    throw new Error('Invalid outbox event');
  }
  if (outbox.status === OUTBOX_STATUS.COMPLETED && outbox.auditLogId) {
    return { skipped: true, auditLogId: outbox.auditLogId };
  }

  const auditLogRecord = await createAuditLog({
    ...(outbox.payload || {}),
    auditEventId: outbox.eventId,
  });

  await markOutboxCompleted(outbox, auditLogRecord);
  return { skipped: false, auditLogId: auditLogRecord._id, auditLogRecord };
}

async function deliverOutboxEventSafe(outbox, { createAuditLog }) {
  try {
    return await deliverOutboxEvent(outbox, { createAuditLog });
  } catch (err) {
    await markOutboxFailed(outbox, err);
    throw err;
  }
}

async function getOutboxMetrics() {
  const [
    pending,
    processing,
    completed,
    failed,
    oldestPending,
    maxRetryPending,
  ] = await Promise.all([
    AuditOutbox.countDocuments({ status: OUTBOX_STATUS.PENDING }),
    AuditOutbox.countDocuments({ status: OUTBOX_STATUS.PROCESSING }),
    AuditOutbox.countDocuments({ status: OUTBOX_STATUS.COMPLETED }),
    AuditOutbox.countDocuments({ status: OUTBOX_STATUS.FAILED }),
    AuditOutbox.findOne({ status: OUTBOX_STATUS.PENDING })
      .sort({ createdAt: 1 })
      .select('eventId createdAt nextRetryAt retryCount module payload.event')
      .lean(),
    AuditOutbox.findOne({ status: OUTBOX_STATUS.PENDING })
      .sort({ retryCount: -1 })
      .select('eventId retryCount lastError')
      .lean(),
  ]);

  return {
    pending,
    processing,
    completed,
    failed,
    permanentlyFailed: failed,
    oldestPending: oldestPending
      ? {
        eventId: oldestPending.eventId,
        createdAt: oldestPending.createdAt,
        nextRetryAt: oldestPending.nextRetryAt,
        retryCount: oldestPending.retryCount || 0,
        module: oldestPending.payload?.module || '',
        event: oldestPending.payload?.event || '',
      }
      : null,
    highestRetryPending: maxRetryPending
      ? {
        eventId: maxRetryPending.eventId,
        retryCount: maxRetryPending.retryCount || 0,
        lastError: maxRetryPending.lastError || '',
      }
      : null,
    collectedAt: ClockService.now(),
  };
}

async function listFailedOutboxEvents(filters = {}, options = {}) {
  const query = { status: OUTBOX_STATUS.FAILED };
  if (filters.module) query['payload.module'] = String(filters.module);
  if (filters.event) query['payload.event'] = String(filters.event);

  const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
  const page = Math.max(1, Number(options.page) || 1);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    AuditOutbox.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    AuditOutbox.countDocuments(query),
  ]);

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  };
}

async function getOutboxEventByEventId(eventId) {
  if (!eventId) return null;
  return AuditOutbox.findOne({ eventId: String(eventId) }).lean();
}

/**
 * Safely replay a permanently failed outbox event without duplicating AuditLog rows.
 */
async function replayFailedOutboxEvent(eventId, { initiatedBy, createAuditLog, req = null }) {
  const outbox = await getOutboxEventByEventId(eventId);
  if (!outbox) {
    const err = new Error('Outbox event not found');
    err.status = 404;
    throw err;
  }
  if (outbox.status !== OUTBOX_STATUS.FAILED) {
    const err = new Error('Only permanently failed outbox events can be replayed');
    err.status = 400;
    throw err;
  }

  const AuditLog = require('../model/auditLog.model');
  const existingAudit = await AuditLog.findOne({ auditEventId: outbox.eventId }).lean();
  if (existingAudit) {
    await AuditOutbox.updateOne(
      { _id: outbox._id, eventId: outbox.eventId },
      {
        $set: {
          status: OUTBOX_STATUS.COMPLETED,
          auditLogId: existingAudit._id,
          processedAt: ClockService.now(),
          lastError: '',
        },
        $push: {
          replayHistory: {
            at: ClockService.now(),
            initiatedBy: initiatedBy || null,
            outcome: 'skipped_duplicate',
            note: 'AuditLog already existed for auditEventId',
          },
        },
      }
    );
    return {
      outcome: 'skipped_duplicate',
      auditLogId: String(existingAudit._id),
      eventId: outbox.eventId,
    };
  }

  await AuditOutbox.updateOne(
    { _id: outbox._id, eventId: outbox.eventId },
    {
      $set: {
        status: OUTBOX_STATUS.PENDING,
        retryCount: 0,
        nextRetryAt: ClockService.now(),
        lastError: '',
        lockedUntil: null,
        lockedBy: '',
      },
      $push: {
        replayHistory: {
          at: ClockService.now(),
          initiatedBy: initiatedBy || null,
          outcome: 'replay_requested',
          note: 'Manual replay initiated by administrator',
        },
      },
    }
  );

  const refreshed = await getOutboxEventByEventId(eventId);
  const deliverFn = createAuditLog || require('./auditLog.service').createAuditLog;

  try {
    const result = await deliverOutboxEvent(refreshed, { createAuditLog: deliverFn });
    await AuditOutbox.updateOne(
      { _id: outbox._id, eventId: outbox.eventId },
      {
        $push: {
          replayHistory: {
            at: ClockService.now(),
            initiatedBy: initiatedBy || null,
            outcome: 'replay_succeeded',
            note: result.skipped ? 'Delivery skipped (already completed)' : 'Delivered to AuditLog',
          },
        },
      }
    );

    const { createAuditLogInBackground } = require('./auditLog.service');
    createAuditLogInBackground({
      module: 'AuditOperations',
      event: 'AuditOutboxReplayed',
      entity: 'AuditOutbox',
      entityId: outbox.eventId,
      createdBy: initiatedBy,
      after: {
        outboxEventId: outbox.eventId,
        originalModule: outbox.payload?.module || '',
        originalEvent: outbox.payload?.event || '',
        outcome: result.skipped ? 'skipped_duplicate' : 'delivered',
        auditLogId: result.auditLogId ? String(result.auditLogId) : '',
      },
      req,
      skipOutbox: true,
    });

    return {
      outcome: result.skipped ? 'skipped_duplicate' : 'delivered',
      auditLogId: result.auditLogId ? String(result.auditLogId) : '',
      eventId: outbox.eventId,
    };
  } catch (err) {
    await AuditOutbox.updateOne(
      { _id: outbox._id, eventId: outbox.eventId },
      {
        $push: {
          replayHistory: {
            at: ClockService.now(),
            initiatedBy: initiatedBy || null,
            outcome: 'replay_failed',
            note: err.message,
          },
        },
      }
    );
    throw err;
  }
}

module.exports = {
  OUTBOX_STATUS,
  computeAuditRetryDelayMs,
  buildClaimableOutboxQuery,
  enqueueAuditEvent,
  claimNextAuditOutboxEvent,
  deliverOutboxEvent,
  deliverOutboxEventSafe,
  markOutboxCompleted,
  markOutboxFailed,
  findOutboxByIdempotencyKey,
  getWorkerId,
  getOutboxMetrics,
  listFailedOutboxEvents,
  getOutboxEventByEventId,
  replayFailedOutboxEvent,
};
