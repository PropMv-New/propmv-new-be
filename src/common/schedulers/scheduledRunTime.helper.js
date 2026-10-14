'use strict';

const { ClockService, SchedulerUtil } = require('../date');
const { automatedNotificationSchedule } = require('../../config/automatedNotificationSchedule.config');

/**
 * Next UTC instant for a daily slot at hour:minute in the configured timezone.
 * Uses ClockService (not server local TZ).
 */
function getNextScheduledRunAt(
  hour,
  minute = 0,
  timeZone = automatedNotificationSchedule.timezone,
) {
  const delay = SchedulerUtil.msUntilNextDailyRun(hour, minute, timeZone);
  return new Date(ClockService.now().getTime() + delay);
}

/**
 * @param {{ hour: number, minute: number, enabled?: boolean }|null|undefined} slot
 * @returns {Date} next run, or "now" when the slot is disabled (send immediately)
 */
function getNextSlotRunAt(slot) {
  if (!slot || slot.enabled === false) {
    return ClockService.now();
  }
  return getNextScheduledRunAt(slot.hour, slot.minute, automatedNotificationSchedule.timezone);
}

function getNextMaintenanceNotificationRunAt() {
  return getNextSlotRunAt(automatedNotificationSchedule.maintenance);
}

function getNextLateFeeNotificationRunAt() {
  return getNextSlotRunAt(automatedNotificationSchedule.lateFee);
}

function getNextNoteReminderRunAt() {
  return getNextSlotRunAt(automatedNotificationSchedule.noteReminder);
}

module.exports = {
  getNextScheduledRunAt,
  getNextSlotRunAt,
  getNextMaintenanceNotificationRunAt,
  getNextLateFeeNotificationRunAt,
  getNextNoteReminderRunAt,
};
