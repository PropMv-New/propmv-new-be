/**
 * ------------------------------------------------------------------
 * File: zillowBulkFeedCronJob.js
 * Module: Backend Background Jobs
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowBulkFeedCronJob.
 *
 * Used By:
 * server
 * ------------------------------------------------------------------
 */
const zillowConfig = require('../integrations/syndication/zillow/zillow.config');
const ZillowFeedFileService = require('../integrations/syndication/zillow/zillowFeedFileService');
const logger = require('../common/logger');
const { SchedulerUtil, TIMEZONE } = require('../common/date');

let schedulerTimer = null;
let isRunning = false;

/**
 * Schedules next bulk feed run at configured ET hours/minute.
 * Runs 20-30 minutes before Zillow's configured fetch time (configurable via env).
 */
function msUntilNextScheduledRun() {
  const runHours = zillowConfig.bulkFeedRunHoursEt.length
    ? zillowConfig.bulkFeedRunHoursEt
    : [4, 16];
  const runMinute = zillowConfig.bulkFeedRunMinuteEt || 30;
  return SchedulerUtil.msUntilNextScheduledRuns(runHours, runMinute, TIMEZONE.BUSINESS);
}

async function runBulkFeedJob() {
  if (isRunning) {
    logger.warn('Zillow bulk feed job skipped - previous run in progress', {
      provider: 'ZILLOW',
      action: 'BULK_FEED',
    });
    return;
  }

  if (!zillowConfig.bulkFeedEnabled) {
    logger.info('Zillow bulk feed job disabled via config', { provider: 'ZILLOW' });
    return;
  }

  isRunning = true;
  try {
    const service = new ZillowFeedFileService({ config: zillowConfig, logger });
    const generateResult = await service.generateBulkFeedFile();

    if (generateResult.success) {
      const processResult = await service.processFeedFileStatuses({
        filePath: generateResult.filePath,
      });
      logger.info('Zillow bulk feed job completed', {
        provider: 'ZILLOW',
        action: 'BULK_FEED',
        listingCount: generateResult.listingCount,
        publishedCount: processResult.publishedCount,
        draftedCount: processResult.draftedCount,
      });
    }
  } catch (error) {
    logger.error('Zillow bulk feed cron job failed', {
      provider: 'ZILLOW',
      action: 'BULK_FEED',
      error: error.message,
    });
  } finally {
    isRunning = false;
    scheduleNextRun();
  }
}

/**
 * schedule Next Run
 *
 * Performs logic operations for scheduleNextRun.
 *
 * @returns Operations result
 */
function scheduleNextRun() {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  const delay = msUntilNextScheduledRun();
  schedulerTimer = setTimeout(runBulkFeedJob, delay);
  logger.info('Zillow bulk feed job scheduled', {
    provider: 'ZILLOW',
    nextRunInMs: delay,
  });
}

/**
 * start Zillow Bulk Feed Cron Job
 *
 * Performs logic operations for startZillowBulkFeedCronJob.
 *
 * @returns Operations result
 */
function startZillowBulkFeedCronJob() {
  if ((process.env.ZILLOW_BULK_FEED_CRON_ENABLED || 'true').toLowerCase() !== 'true') {
    logger.info('Zillow bulk feed cron disabled', { provider: 'ZILLOW' });
    return;
  }

  const startupDelay = zillowConfig.bulkFeedStartupDelayMs;
  setTimeout(() => {
    scheduleNextRun();
  }, startupDelay);

  logger.info('Zillow bulk feed cron initialized', { provider: 'ZILLOW', startupDelay });
}

module.exports = {
  startZillowBulkFeedCronJob,
  runBulkFeedJob,
  msUntilNextScheduledRun,
};
