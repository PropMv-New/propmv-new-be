'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  claimNextAuditOutboxEvent,
  deliverOutboxEventSafe,
  getWorkerId,
} = require('../../shared/modules/audit/service/auditOutbox.service');
const { createAuditLog } = require('../../shared/modules/audit/service/auditLog.service');
const logger = require('../logger');

const ENABLED = process.env.AUDIT_OUTBOX_ENABLED !== 'false';
const POLL_INTERVAL_MS = Number(process.env.AUDIT_OUTBOX_POLL_INTERVAL_MS) || 5_000;
const STARTUP_DELAY_MS = Number(process.env.AUDIT_OUTBOX_STARTUP_DELAY_MS) || 10_000;
const BATCH_SIZE = Number(process.env.AUDIT_OUTBOX_BATCH_SIZE) || 20;

let pollTimer = null;
let isRunning = false;

async function processAuditOutboxBatch(options = {}) {
  if (isRunning) {
    return { skipped: true, reason: 'batch_in_progress' };
  }

  isRunning = true;
  const workerId = options.workerId || getWorkerId();
  const batchSize = options.batchSize || BATCH_SIZE;
  const deliver = options.createAuditLog || createAuditLog;

  let claimed = 0;
  let delivered = 0;
  let failed = 0;

  try {
    for (let i = 0; i < batchSize; i += 1) {
      const outbox = await claimNextAuditOutboxEvent(workerId);
      if (!outbox) break;
      claimed += 1;
      try {
        await deliverOutboxEventSafe(outbox, { createAuditLog: deliver });
        delivered += 1;
      } catch (_err) {
        failed += 1;
      }
    }

    if (claimed > 0) {
      logger.info('[AuditOutboxWorker] Batch complete', { claimed, delivered, failed, workerId });
    }

    if (claimed > 0 || failed > 0) {
      try {
        const { getOutboxMetrics } = require('../../shared/modules/audit/service/auditOutbox.service');
        const metrics = await getOutboxMetrics();
        if (metrics.pending > 0 || metrics.failed > 0) {
          logger.info('[AuditOutboxWorker] Queue snapshot', {
            pending: metrics.pending,
            processing: metrics.processing,
            failed: metrics.failed,
            oldestPendingEventId: metrics.oldestPending?.eventId || '',
          });
        }
        if (metrics.pending >= Number(process.env.AUDIT_OUTBOX_BACKLOG_WARN || 100)) {
          logger.warn('[AuditOutboxWorker] Outbox backlog threshold exceeded', metrics);
        }
      } catch (metricsErr) {
        logger.warn('[AuditOutboxWorker] Metrics snapshot failed', { error: metricsErr.message });
      }
    }

    return { claimed, delivered, failed, workerId };
  } finally {
    isRunning = false;
  }
}

function startAuditOutboxWorker() {
  if (!ENABLED) {
    logger.info('[AuditOutboxWorker] Disabled via AUDIT_OUTBOX_ENABLED=false');
    return { started: false };
  }

  if (pollTimer) {
    return { started: false, reason: 'already_running' };
  }

  const workerId = getWorkerId();

  const tick = () => {
    processAuditOutboxBatch({ workerId }).catch((err) => {
      logger.error('[AuditOutboxWorker] Batch error', { error: err.message, workerId });
    });
  };

  setTimeout(() => {
    tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    logger.info('[AuditOutboxWorker] Started', {
      workerId,
      pollIntervalMs: POLL_INTERVAL_MS,
      batchSize: BATCH_SIZE,
    });
  }, STARTUP_DELAY_MS);

  return { started: true, workerId };
}

function stopAuditOutboxWorker() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  startAuditOutboxWorker,
  stopAuditOutboxWorker,
  processAuditOutboxBatch,
};
