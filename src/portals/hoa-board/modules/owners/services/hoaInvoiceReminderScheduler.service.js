const logger = require('../../../../../common/logger');

/**
 * ------------------------------------------------------------------
 * File: hoaInvoiceReminderScheduler.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * server
 * ------------------------------------------------------------------
 */
const {
  enqueueAutomatedPaymentReminders,
  enqueueFailedReminderRetry,
} = require('../../../../../common/helpers/paymentReminderAutomation.service');
const { ClockService } = require('../../../../../common/date');
const { startHourlyPropertyMidnightRun } = require('../../../../../common/schedulers/scheduledDailyRun.service');
const { automatedNotificationSchedule } = require('../../../../../config/automatedNotificationSchedule.config');

let reminderSchedulerHandle = null;

async function processInvoiceReminderBatch(
  referenceDate = ClockService.now(),
  reminderPhase = 'all',
  options = {},
) {
  const reminders = await enqueueAutomatedPaymentReminders(referenceDate, {
    reminderPhase,
    billingTimezones: options.billingTimezones,
  });
  const retry = reminderPhase === 'all' || reminderPhase === 'overdue'
    ? await enqueueFailedReminderRetry(referenceDate, {
      billingTimezones: options.billingTimezones,
    }).catch((err) => {
      logger.error('[hoaInvoiceReminderScheduler] Retry enqueue failed:', err?.message || err);
      return { enqueued: 0, recovered: 0 };
    })
    : { enqueued: 0, recovered: 0 };

  logger.info(
    `[hoaInvoiceReminderScheduler] phase=${reminderPhase} unpaid=${reminders.totalUnpaid || 0}, processed=${reminders.processed || 0}, enqueued=${reminders.enqueued || 0}, duplicate=${reminders.duplicate || 0}, disabledSkipped=${reminders.skippedDisabled || 0}, timezoneSkipped=${reminders.skippedTimezone || 0}, retryEnqueued=${retry.enqueued || 0}`
  );
  return { reminders, retry };
}

/**
 * start Hoa Invoice Reminder Scheduler
 *
 * Performs logic operations for startHoaInvoiceReminderScheduler.
 *
 * @returns Operations result
 */
function startHoaInvoiceReminderScheduler() {
  const {
    skipStartupRun,
    invoiceDue,
    invoiceOverdue,
  } = automatedNotificationSchedule;

  const enabled = invoiceDue.enabled || invoiceOverdue.enabled;
  if (!enabled) {
    logger.info('[hoaInvoiceReminderScheduler] Disabled via scheduler configuration');
    return;
  }

  const sharedStartupSkip = skipStartupRun || process.env.HOA_INVOICE_REMINDER_SKIP_STARTUP_RUN === 'true';
  const reminderPhase = invoiceDue.enabled && invoiceOverdue.enabled
    ? 'all'
    : invoiceDue.enabled
      ? 'due'
      : 'overdue';

  reminderSchedulerHandle = startHourlyPropertyMidnightRun({
    name: 'hoaInvoiceReminderScheduler',
    enabled: true,
    skipStartupRun: sharedStartupSkip,
    startupDelayMs: invoiceDue.startupDelayMs || invoiceOverdue.startupDelayMs || 90_000,
    onRun: ({ midnightZones, now }) => processInvoiceReminderBatch(now, reminderPhase, {
      billingTimezones: midnightZones,
    }),
  });

  logger.info(
    `[hoaInvoiceReminderScheduler] Payment reminders run at 12:00 AM in each property timezone (phase=${reminderPhase})`
  );
  return reminderSchedulerHandle;
}

module.exports = {
  startHoaInvoiceReminderScheduler,
  processInvoiceReminderBatch,
};
