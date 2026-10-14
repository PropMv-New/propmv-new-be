'use strict';

const logger = require('../logger');
const { dailySchedule } = require('../../config/dailySchedule.config');

const handles = [];

function startSchedulerSafely(name, startFn) {
  try {
    const handle = startFn();
    if (handle && typeof handle.stop === 'function') {
      handles.push(handle);
    }
    return { started: true, name };
  } catch (err) {
    logger.warn(`[SchedulerRegistry] Failed to start ${name}`, { error: err?.message || err });
    return { started: false, name, error: err?.message || String(err) };
  }
}

/**
 * Start all PROPMV backend schedulers from a single registry.
 * Daily HOA tasks share CRON_SCHEDULE + CRON_TIMEZONE from .env.
 */
function startAllSchedulers() {
  if (!dailySchedule.enabled) {
    logger.info('[SchedulerRegistry] All schedulers disabled via SCHEDULERS_ENABLED=false');
    return { started: false, reason: 'disabled' };
  }

  const results = [];

  results.push(startSchedulerSafely('propertyLateFeeScheduler', () => {
    const { startPropertyLateFeeScheduler } = require('./propertyLateFeeScheduler.service');
    startPropertyLateFeeScheduler();
    return null;
  }));

  if (process.env.HOA_LATE_FEE_LEGACY_DAILY_SCHEDULER_ENABLED === 'true') {
    results.push(startSchedulerSafely('hoaLateFeeScheduler', () => {
      const { startHoaLateFeeScheduler } = require('../../portals/hoa-board/modules/owners/services/hoaLateFeeScheduler.service');
      startHoaLateFeeScheduler();
      return null;
    }));
  }

  results.push(startSchedulerSafely('hoaInvoiceExtensionScheduler', () => {
    const { startHoaInvoiceExtensionScheduler } = require('../../portals/hoa-board/modules/owners/services/hoaInvoiceExtensionScheduler.service');
    startHoaInvoiceExtensionScheduler();
    return null;
  }));

  results.push(startSchedulerSafely('hoaOwnershipTransferScheduler', () => {
    const { startHoaOwnershipTransferScheduler } = require('../../portals/hoa-board/modules/owners/services/hoaOwnershipTransferScheduler.service');
    startHoaOwnershipTransferScheduler();
    return null;
  }));

  results.push(startSchedulerSafely('hoaInvoiceReminderScheduler', () => {
    const { startHoaInvoiceReminderScheduler } = require('../../portals/hoa-board/modules/owners/services/hoaInvoiceReminderScheduler.service');
    startHoaInvoiceReminderScheduler();
    return null;
  }));

  results.push(startSchedulerSafely('noteReminderScheduler', () => {
    const { startNoteReminderScheduler } = require('./noteReminderScheduler.service');
    startNoteReminderScheduler();
    return null;
  }));

  results.push(startSchedulerSafely('zillowBulkFeedCronJob', () => {
    const { startZillowBulkFeedCronJob } = require('../../jobs/zillowBulkFeedCronJob');
    startZillowBulkFeedCronJob();
    return null;
  }));

  results.push(startSchedulerSafely('bounceImapPoller', () => {
    const { startBounceImapPoller } = require('../helpers/emailBounceImapPoller.service');
    startBounceImapPoller();
    return null;
  }));

  results.push(startSchedulerSafely('auditOutboxWorker', () => {
    const { startAuditOutboxWorker } = require('./auditOutboxWorker.service');
    startAuditOutboxWorker();
    return null;
  }));

  results.push(startSchedulerSafely('rainforestOperationsCronJob', () => {
    const { startRainforestOperationsCronJob } = require('../../jobs/rainforestOperationsCronJob');
    startRainforestOperationsCronJob();
    return null;
  }));

  results.push(startSchedulerSafely('hoaOnboardingReportScheduler', () => {
    const { startHoaOnboardingReportScheduler } = require('./hoaOnboardingReportScheduler.service');
    startHoaOnboardingReportScheduler();
    return null;
  }));

  results.push(startSchedulerSafely('hoaTrialReminderScheduler', () => {
    const { startHoaTrialReminderScheduler } = require('./hoaTrialReminderScheduler.service');
    startHoaTrialReminderScheduler();
    return null;
  }));

  results.push(startSchedulerSafely('payloadAutopayInvoiceSyncScheduler', () => {
    const { startPayloadAutopayInvoiceSyncScheduler } = require('./payloadAutopayInvoiceSyncScheduler.service');
    return startPayloadAutopayInvoiceSyncScheduler();
  }));

  const startedCount = results.filter((row) => row.started).length;
  logger.info('[SchedulerRegistry] Startup complete', {
    startedCount,
    dailySchedule: dailySchedule.label,
    timezone: dailySchedule.timezone,
    cronExpression: dailySchedule.cronExpression,
    leaderLockEnabled: dailySchedule.leaderLockEnabled,
  });

  return { started: true, results, dailySchedule: dailySchedule.label };
}

function stopAllSchedulers() {
  for (const handle of handles) {
    try {
      handle.stop();
    } catch (err) {
      logger.warn('[SchedulerRegistry] Stop failed', { error: err?.message || err });
    }
  }
  handles.length = 0;

  try {
    const { stopAuditOutboxWorker } = require('./auditOutboxWorker.service');
    stopAuditOutboxWorker();
  } catch {
    // optional
  }
}

module.exports = {
  startAllSchedulers,
  stopAllSchedulers,
};
