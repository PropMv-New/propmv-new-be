'use strict';

const logger = require('../logger');
const { ClockService } = require('../date');
const { startScheduledDailyRun } = require('./scheduledDailyRun.service');
const { dailySchedule } = require('../../config/dailySchedule.config');
const {
  parseTimeOfDay,
  formatScheduleLabel,
} = require('./scheduleParse.util');

function envBool(name, defaultValue = 'false') {
  return (process.env[name] ?? defaultValue).toString().toLowerCase() === 'true';
}

let schedulerHandle = null;

function resolveReportSchedule() {
  const parsed =
    parseTimeOfDay(process.env.HOA_ONBOARDING_REPORT_TIME) ||
    { hour: 13, minute: 0 };

  return {
    hour: parsed.hour,
    minute: parsed.minute,
    label: formatScheduleLabel(parsed, dailySchedule.timezone),
    timezone: dailySchedule.timezone,
    timezoneLabel: dailySchedule.timezoneLabel,
  };
}

function startHoaOnboardingReportScheduler() {
  if (!envBool('HOA_ONBOARDING_REPORT_ENABLED', 'true')) {
    logger.info('[hoaOnboardingReportScheduler] Disabled via HOA_ONBOARDING_REPORT_ENABLED=false');
    return;
  }

  const schedule = resolveReportSchedule();
  const skipStartupRun =
    dailySchedule.skipStartupRun ||
    envBool('HOA_ONBOARDING_REPORT_SKIP_STARTUP_RUN', 'true');

  schedulerHandle = startScheduledDailyRun({
    name: 'hoaOnboardingReportScheduler',
    hour: schedule.hour,
    minute: schedule.minute,
    timeZone: schedule.timezone,
    enabled: true,
    skipStartupRun,
    startupDelayMs: Number(process.env.HOA_ONBOARDING_REPORT_STARTUP_DELAY_MS) || 0,
    onRun: async () => {
      try {
        const { sendHoaOnboardingReportEmail } = require('../../shared/modules/system/reports/service/hoaOnboardingReportNotify.service');
        return await sendHoaOnboardingReportEmail({
          referenceDate: ClockService.now(),
          triggerSource: 'cron',
        });
      } catch (err) {
        logger.error('[hoaOnboardingReportScheduler] Execution error during daily report run', {
          error: err.message,
        });
        return { sent: false, error: err.message };
      }
    },
  });

  logger.info(
    `[hoaOnboardingReportScheduler] Report emails at ${schedule.label} (${schedule.timezoneLabel})`
  );
}

function stopHoaOnboardingReportScheduler() {
  if (schedulerHandle && typeof schedulerHandle.stop === 'function') {
    schedulerHandle.stop();
  }
  schedulerHandle = null;
}

module.exports = {
  startHoaOnboardingReportScheduler,
  stopHoaOnboardingReportScheduler,
};
