'use strict';

const { TIMEZONE, TIMEZONE_LABEL } = require('../common/date/constants/date.constants');
const {
  parseTimeOfDay,
  parseDailyCronExpression,
  formatScheduleLabel,
} = require('../common/schedulers/scheduleParse.util');

function envBool(name, defaultValue = 'false') {
  return (process.env[name] ?? defaultValue).toString().toLowerCase() === 'true';
}

/**
 * Timezone for all daily cron jobs. Per-job times (HH:MM) are staggered by default -
 * see STAGGERED_DAILY_DEFAULTS in automatedNotificationSchedule.config.js.
 *
 * Configure via .env:
 *   CRON_TIMEZONE=America/New_York
 *   INVOICE_NOTIFICATION_TIME=00:30  (example per-job override)
 */
function resolveDailySchedule() {
  const cronExpr = process.env.CRON_SCHEDULE
    || process.env.DAILY_CRON_SCHEDULE
    || '0 0 * * *';

  const timezone = process.env.CRON_TIMEZONE
    || process.env.DAILY_SCHEDULE_TIMEZONE
    || process.env.AUTOMATED_NOTIFICATION_TIMEZONE
    || TIMEZONE.BUSINESS;

  const timezoneLabel = process.env.CRON_TIMEZONE_LABEL
    || process.env.DAILY_SCHEDULE_TIMEZONE_LABEL
    || process.env.AUTOMATED_NOTIFICATION_TIMEZONE_LABEL
    || TIMEZONE_LABEL.BUSINESS;

  const fromCron = parseDailyCronExpression(cronExpr);
  const fromTimeEnv = parseTimeOfDay(process.env.DAILY_SCHEDULE_TIME)
    || parseTimeOfDay(process.env.AUTOMATED_NOTIFICATION_TIME)
    || parseTimeOfDay(process.env.AUTOMATED_NOTIFICATION_TIME_ET);

  const slot = fromCron || fromTimeEnv || { hour: 0, minute: 0 };

  return {
    cronExpression: cronExpr,
    hour: slot.hour,
    minute: slot.minute,
    timezone,
    timezoneLabel,
    label: formatScheduleLabel(slot, timezone),
    skipStartupRun: envBool('SCHEDULER_SKIP_STARTUP_RUN', process.env.AUTOMATED_NOTIFICATION_SKIP_STARTUP_RUN || 'false'),
    enabled: envBool('SCHEDULERS_ENABLED', 'true'),
    leaderLockEnabled: envBool('SCHEDULER_LEADER_LOCK_ENABLED', 'true'),
    leaderLockMs: Number(process.env.SCHEDULER_LEADER_LOCK_MS) || 3_600_000,
  };
}

const dailySchedule = resolveDailySchedule();

module.exports = {
  dailySchedule,
  resolveDailySchedule,
  formatScheduleLabel,
  parseTimeOfDay,
  parseDailyCronExpression,
};
