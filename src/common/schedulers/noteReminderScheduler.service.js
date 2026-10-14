'use strict';

const logger = require('../logger');
const { ClockService } = require('../date');
const { enqueueBackgroundJob } = require('../jobs/enqueue');
const { JOB_TYPES } = require('../jobs/constants');
const { buildJobIdempotencyKey } = require('../jobs/idempotency');
const { isBackgroundJobsEnabled } = require('../jobs/config');
const { getDateKeyInTimeZone } = require('../helpers/hoaBillingDates');
const { startScheduledDailyRun } = require('./scheduledDailyRun.service');
const { automatedNotificationSchedule } = require('../../config/automatedNotificationSchedule.config');
const { processDueNoteReminders } = require('../services/noteReminder.service');

let schedulerHandle = null;

async function enqueueNoteReminderSweep(referenceDate = ClockService.now()) {
  if (!isBackgroundJobsEnabled()) {
    await processDueNoteReminders();
    return { processed: 1, enqueued: 0, duplicate: 0, inline: true };
  }

  const dateKey = getDateKeyInTimeZone(
    referenceDate,
    automatedNotificationSchedule.timezone
  );

  try {
    const result = await enqueueBackgroundJob({
      jobType: JOB_TYPES.EMAIL_NOTE_REMINDER_SWEEP,
      entityType: 'System',
      entityId: 'note-reminder-sweep',
      idempotencyKey: buildJobIdempotencyKey('EMAIL_NOTE_REMINDER_SWEEP', dateKey),
      payload: { dateKey },
    });
    logger.info(
      `[noteReminderScheduler] Enqueued daily sweep duplicate=${Boolean(result.duplicate)} dateKey=${dateKey}`
    );
    return {
      processed: 1,
      enqueued: result.duplicate ? 0 : 1,
      duplicate: result.duplicate ? 1 : 0,
      failed: 0,
    };
  } catch (error) {
    logger.warn('[noteReminderScheduler] Enqueue failed:', error?.message || error);
    return { processed: 0, enqueued: 0, duplicate: 0, failed: 1 };
  }
}

function startNoteReminderScheduler() {
  const {
    timezone,
    timezoneLabel,
    skipStartupRun,
    noteReminder,
  } = automatedNotificationSchedule;

  if (!noteReminder?.enabled) {
    logger.info('[noteReminderScheduler] Disabled via HOA_NOTE_REMINDER_SCHEDULER_ENABLED=false');
    return;
  }

  const noteStartupSkip = skipStartupRun
    || process.env.HOA_NOTE_REMINDER_SKIP_STARTUP_RUN === 'true';

  schedulerHandle = startScheduledDailyRun({
    name: 'noteReminderScheduler',
    hour: noteReminder.hour,
    minute: noteReminder.minute,
    timeZone: timezone,
    enabled: true,
    skipStartupRun: noteStartupSkip,
    startupDelayMs: noteReminder.startupDelayMs,
    onRun: () => enqueueNoteReminderSweep(ClockService.now()),
  });

  logger.info(
    `[noteReminderScheduler] Note reminder emails at ${noteReminder.label} (${timezoneLabel})`
  );
}

module.exports = {
  startNoteReminderScheduler,
  enqueueNoteReminderSweep,
};
