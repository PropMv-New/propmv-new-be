'use strict';

const { TIMEZONE_LABEL } = require('../common/date/constants/date.constants');
const { dailySchedule } = require('./dailySchedule.config');
const {
  parseTimeOfDay,
  formatScheduleLabel,
} = require('../common/schedulers/scheduleParse.util');

/** Default UTC times - staggered so daily jobs do not all fire at once. Override via .env per job. */
const STAGGERED_DAILY_DEFAULTS = Object.freeze({
  ownershipTransfer: '00:00',
  futureInvoice: '00:15',
  invoiceDue: '00:30',
  invoiceOverdue: '00:45',
  noteReminder: '01:00',
  maintenance: '01:15',
  lateFee: '01:30',
  hoaTrial: '01:45',
});

function envBool(name, defaultValue = 'false') {
  return (process.env[name] ?? defaultValue).toString().toLowerCase() === 'true';
}

function envNumber(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function resolveScheduleSlot({
  timeEnvNames = [],
  legacyHourEnv,
  legacyMinuteEnv,
  defaultTime,
}) {
  for (const envName of timeEnvNames) {
    const parsed = parseTimeOfDay(process.env[envName]);
    if (parsed) return parsed;
  }

  if (legacyHourEnv && process.env[legacyHourEnv] != null && process.env[legacyHourEnv] !== '') {
    return {
      hour: envNumber(legacyHourEnv, dailySchedule.hour),
      minute: legacyMinuteEnv ? envNumber(legacyMinuteEnv, dailySchedule.minute) : dailySchedule.minute,
    };
  }

  const parsedDefault = parseTimeOfDay(defaultTime);
  if (parsedDefault) return parsedDefault;

  return { hour: dailySchedule.hour, minute: dailySchedule.minute };
}

const ownershipTransfer = resolveScheduleSlot({
  timeEnvNames: ['OWNERSHIP_TRANSFER_SCHEDULE_TIME'],
  defaultTime: STAGGERED_DAILY_DEFAULTS.ownershipTransfer,
});

const invoiceDue = resolveScheduleSlot({
  timeEnvNames: [
    'INVOICE_NOTIFICATION_TIME',
    'INVOICE_DUE_NOTIFICATION_TIME',
  ],
  legacyHourEnv: 'HOA_INVOICE_REMINDER_RUN_HOUR_ET',
  legacyMinuteEnv: 'HOA_INVOICE_REMINDER_RUN_MINUTE_ET',
  defaultTime: STAGGERED_DAILY_DEFAULTS.invoiceDue,
});

const invoiceOverdue = resolveScheduleSlot({
  timeEnvNames: [
    'OVERDUE_NOTIFICATION_TIME',
    'INVOICE_OVERDUE_NOTIFICATION_TIME',
  ],
  legacyHourEnv: 'HOA_INVOICE_OVERDUE_RUN_HOUR_ET',
  legacyMinuteEnv: 'HOA_INVOICE_OVERDUE_RUN_MINUTE_ET',
  defaultTime: STAGGERED_DAILY_DEFAULTS.invoiceOverdue,
});

const futureInvoice = resolveScheduleSlot({
  timeEnvNames: [
    'FUTURE_INVOICE_NOTIFICATION_TIME',
    'FUTURE_HOA_INVOICE_NOTIFICATION_TIME',
  ],
  legacyHourEnv: 'HOA_INVOICE_EXTENSION_RUN_HOUR_ET',
  legacyMinuteEnv: 'HOA_INVOICE_EXTENSION_RUN_MINUTE_ET',
  defaultTime: STAGGERED_DAILY_DEFAULTS.futureInvoice,
});

const maintenance = resolveScheduleSlot({
  timeEnvNames: ['MAINTENANCE_NOTIFICATION_TIME'],
  legacyHourEnv: 'HOA_MAINTENANCE_NOTIFICATION_RUN_HOUR_ET',
  legacyMinuteEnv: 'HOA_MAINTENANCE_NOTIFICATION_RUN_MINUTE_ET',
  defaultTime: STAGGERED_DAILY_DEFAULTS.maintenance,
});

const lateFee = resolveScheduleSlot({
  timeEnvNames: [
    'LATE_FEE_NOTIFICATION_TIME',
    'LATE_FEE_EMAIL_NOTIFICATION_TIME',
  ],
  legacyHourEnv: 'HOA_LATE_FEE_NOTIFICATION_RUN_HOUR_ET',
  legacyMinuteEnv: 'HOA_LATE_FEE_NOTIFICATION_RUN_MINUTE_ET',
  defaultTime: STAGGERED_DAILY_DEFAULTS.lateFee,
});

const noteReminder = resolveScheduleSlot({
  timeEnvNames: [
    'NOTE_REMINDER_NOTIFICATION_TIME',
    'NOTE_REMINDER_TIME',
  ],
  legacyHourEnv: 'HOA_NOTE_REMINDER_RUN_HOUR_ET',
  legacyMinuteEnv: 'HOA_NOTE_REMINDER_RUN_MINUTE_ET',
  defaultTime: STAGGERED_DAILY_DEFAULTS.noteReminder,
});

const hoaTrial = resolveScheduleSlot({
  timeEnvNames: ['HOA_TRIAL_NOTIFICATION_TIME'],
  defaultTime: STAGGERED_DAILY_DEFAULTS.hoaTrial,
});

function schedulesShareSameTime(left, right) {
  return left.hour === right.hour && left.minute === right.minute;
}

const automatedNotificationSchedule = {
  dailySchedule,
  staggeredDailyDefaults: STAGGERED_DAILY_DEFAULTS,
  timezone: dailySchedule.timezone,
  timezoneLabel: dailySchedule.timezoneLabel || TIMEZONE_LABEL.BUSINESS,
  skipStartupRun: dailySchedule.skipStartupRun,
  ownershipTransfer: {
    ...ownershipTransfer,
    enabled: envBool('HOA_OWNERSHIP_TRANSFER_SCHEDULER_ENABLED', 'true'),
    startupDelayMs: envNumber('HOA_OWNERSHIP_TRANSFER_STARTUP_DELAY_MS', 120_000),
    label: formatScheduleLabel(ownershipTransfer, dailySchedule.timezone),
  },
  invoiceDue: {
    ...invoiceDue,
    enabled: envBool('HOA_INVOICE_REMINDER_SCHEDULER_ENABLED', 'true'),
    startupDelayMs: envNumber('HOA_INVOICE_REMINDER_STARTUP_DELAY_MS', 90_000),
    label: formatScheduleLabel(invoiceDue, dailySchedule.timezone),
  },
  invoiceOverdue: {
    ...invoiceOverdue,
    enabled: envBool('HOA_INVOICE_OVERDUE_REMINDER_SCHEDULER_ENABLED', 'true'),
    startupDelayMs: envNumber('HOA_INVOICE_OVERDUE_REMINDER_STARTUP_DELAY_MS', 90_000),
    label: formatScheduleLabel(invoiceOverdue, dailySchedule.timezone),
  },
  futureInvoice: {
    ...futureInvoice,
    enabled: envBool('HOA_INVOICE_EXTENSION_SCHEDULER_ENABLED', 'true'),
    startupDelayMs: envNumber('HOA_INVOICE_EXTENSION_STARTUP_DELAY_MS', 120_000),
    label: formatScheduleLabel(futureInvoice, dailySchedule.timezone),
  },
  maintenance: {
    ...maintenance,
    enabled: envBool('HOA_MAINTENANCE_NOTIFICATION_SCHEDULER_ENABLED', 'true'),
    label: formatScheduleLabel(maintenance, dailySchedule.timezone),
  },
  lateFee: {
    ...lateFee,
    enabled: envBool('HOA_LATE_FEE_NOTIFICATION_SCHEDULER_ENABLED', 'true'),
    label: formatScheduleLabel(lateFee, dailySchedule.timezone),
  },
  noteReminder: {
    ...noteReminder,
    enabled: envBool('HOA_NOTE_REMINDER_SCHEDULER_ENABLED', 'true'),
    startupDelayMs: envNumber('HOA_NOTE_REMINDER_STARTUP_DELAY_MS', 150_000),
    label: formatScheduleLabel(noteReminder, dailySchedule.timezone),
  },
  hoaTrial: {
    ...hoaTrial,
    enabled: envBool('HOA_TRIAL_REMINDER_SCHEDULER_ENABLED', 'true'),
    startupDelayMs: envNumber('HOA_TRIAL_REMINDER_STARTUP_DELAY_MS', 180_000),
    label: formatScheduleLabel(hoaTrial, dailySchedule.timezone),
  },
  invoiceRemindersShareSchedule: schedulesShareSameTime(invoiceDue, invoiceOverdue),
};

module.exports = {
  automatedNotificationSchedule,
  STAGGERED_DAILY_DEFAULTS,
  parseTimeOfDay,
  formatScheduleLabel,
  resolveScheduleSlot,
};
