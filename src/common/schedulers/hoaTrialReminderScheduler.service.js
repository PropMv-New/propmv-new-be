'use strict';

const logger = require('../logger');
const { ClockService } = require('../date');
const { startScheduledDailyRun } = require('./scheduledDailyRun.service');
const { automatedNotificationSchedule } = require('../../config/automatedNotificationSchedule.config');
const { runHoaTrialReminderSweep } = require('../../portals/hoa-board/modules/hoa/service/hoaTrialNotification.service');

let schedulerHandle = null;

function startHoaTrialReminderScheduler() {
  const slot = automatedNotificationSchedule.hoaTrial;
  if (!slot?.enabled) {
    logger.info('[hoaTrialReminderScheduler] Disabled via HOA_TRIAL_REMINDER_SCHEDULER_ENABLED=false');
    return;
  }

  const skipStartupRun = automatedNotificationSchedule.skipStartupRun
    || process.env.HOA_TRIAL_REMINDER_SKIP_STARTUP_RUN === 'true';

  schedulerHandle = startScheduledDailyRun({
    name: 'hoaTrialReminderScheduler',
    hour: slot.hour,
    minute: slot.minute,
    timeZone: automatedNotificationSchedule.timezone,
    enabled: true,
    skipStartupRun,
    startupDelayMs: slot.startupDelayMs,
    onRun: () => runHoaTrialReminderSweep(ClockService.now()),
  });

  logger.info(
    `[hoaTrialReminderScheduler] HOA trial emails at ${slot.label} (${automatedNotificationSchedule.timezoneLabel})`
  );
}

function stopHoaTrialReminderScheduler() {
  if (schedulerHandle && typeof schedulerHandle.stop === 'function') {
    schedulerHandle.stop();
  }
  schedulerHandle = null;
}

module.exports = {
  startHoaTrialReminderScheduler,
  stopHoaTrialReminderScheduler,
};
