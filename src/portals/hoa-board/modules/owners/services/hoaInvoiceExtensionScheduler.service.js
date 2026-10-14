const logger = require('../../../../../common/logger');

/**
 * ------------------------------------------------------------------
 * File: hoaInvoiceExtensionScheduler.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * server
 * ------------------------------------------------------------------
 */
const { processAllUnitsInvoiceExtension } = require('./invoiceScheduleMeta.service');
const { ClockService } = require('../../../../../common/date');
const jobsEnqueue = require('../../../../../common/jobs/enqueue');
const { JOB_TYPES } = require('../../../../../common/jobs/constants');
const { buildJobIdempotencyKey } = require('../../../../../common/jobs/idempotency');
const jobsConfig = require('../../../../../common/jobs/config');
const { getDateKeyInTimeZone } = require('../../../../../common/helpers/hoaBillingDates');
const { startHourlyPropertyMidnightRun } = require('../../../../../common/schedulers/scheduledDailyRun.service');
const { automatedNotificationSchedule } = require('../../../../../config/automatedNotificationSchedule.config');

let schedulerHandle = null;

async function enqueueAllUnitsInvoiceExtension(options = {}) {
  const billingTimezone = options.billingTimezone || null;
  if (!jobsConfig.isBackgroundJobsEnabled()) {
    return processAllUnitsInvoiceExtension({ billingTimezone });
  }

  const dateKey = getDateKeyInTimeZone(ClockService.now(), billingTimezone || undefined);
  try {
    const result = await jobsEnqueue.enqueueBackgroundJob({
      jobType: JOB_TYPES.INVOICE_EXTENSION_ALL,
      entityType: 'System',
      entityId: billingTimezone
        ? `hoa-invoice-extension:${billingTimezone}`
        : 'hoa-invoice-extension',
      idempotencyKey: buildJobIdempotencyKey(
        'INVOICE_EXTENSION_ALL',
        dateKey,
        billingTimezone || '',
      ),
      payload: { billingTimezone, options: { billingTimezone } },
    });
    logger.info(
      `[hoaInvoiceExtensionScheduler] Enqueued extension job timezone=${billingTimezone || 'all'} duplicate=${Boolean(result.duplicate)}`,
    );
    return {
      processed: 1,
      enqueued: result.duplicate ? 0 : 1,
      duplicate: result.duplicate ? 1 : 0,
      failed: 0,
    };
  } catch (error) {
    logger.warn('[hoaInvoiceExtensionScheduler] Enqueue failed:', error?.message || error);
    return { processed: 0, enqueued: 0, duplicate: 0, failed: 1 };
  }
}

async function enqueueMidnightInvoiceExtensions({ midnightZones }) {
  const zones = Array.isArray(midnightZones) ? midnightZones : [];
  let processed = 0;
  let enqueued = 0;
  let duplicate = 0;
  let failed = 0;

  for (const timezone of zones) {
    const result = await enqueueAllUnitsInvoiceExtension({ billingTimezone: timezone });
    processed += result.processed || 0;
    enqueued += result.enqueued || 0;
    duplicate += result.duplicate || 0;
    failed += result.failed || 0;
  }

  return { processed, enqueued, duplicate, failed, midnightZones: zones };
}

/**
 * start Hoa Invoice Extension Scheduler
 *
 * Performs logic operations for startHoaInvoiceExtensionScheduler.
 *
 * @returns Operations result
 */
function startHoaInvoiceExtensionScheduler() {
  const {
    skipStartupRun,
    futureInvoice,
  } = automatedNotificationSchedule;

  if (!futureInvoice.enabled) {
    logger.info('[hoaInvoiceExtensionScheduler] Disabled via HOA_INVOICE_EXTENSION_SCHEDULER_ENABLED=false');
    return;
  }

  const extensionStartupSkip = skipStartupRun
    || process.env.HOA_INVOICE_EXTENSION_SKIP_STARTUP_RUN === 'true';

  schedulerHandle = startHourlyPropertyMidnightRun({
    name: 'hoaInvoiceExtensionScheduler',
    enabled: true,
    skipStartupRun: extensionStartupSkip,
    startupDelayMs: futureInvoice.startupDelayMs,
    onRun: enqueueMidnightInvoiceExtensions,
  });

  logger.info(
    '[hoaInvoiceExtensionScheduler] Next-year HOA invoice generation at 12:00 AM in each property timezone'
  );
  return schedulerHandle;
}

module.exports = {
  startHoaInvoiceExtensionScheduler,
  processAllUnitsInvoiceExtension,
  enqueueAllUnitsInvoiceExtension,
  enqueueMidnightInvoiceExtensions,
};
