'use strict';



const logger = require('../logger');

const { SchedulerUtil } = require('../date');

const { getDateKeyInTimeZone } = require('../helpers/hoaBillingDates');

const { ClockService } = require('../date');

const { withSchedulerLeaderLock } = require('./schedulerLeaderLock.service');

const { getBillingTimezonesAtLocalHour } = require('../helpers/billingCalendar');



/**

 * Schedule a daily callback at a fixed hour:minute in the configured timezone.

 * The callback should enqueue work - not perform bulk email delivery inline.

 */

function startScheduledDailyRun({

  name,

  hour,

  minute = 0,

  timeZone,

  enabled = true,

  skipStartupRun = false,

  startupDelayMs = 0,

  useLeaderLock = true,

  onRun,

}) {

  if (!enabled) {

    logger.info(`[${name}] Disabled via configuration`);

    return { stop: () => {} };

  }



  if (typeof onRun !== 'function') {

    throw new Error(`[${name}] onRun callback is required`);

  }



  let schedulerTimer = null;

  let startupTimer = null;

  let isRunning = false;



  const executeRun = async (context = 'daily') => {

    if (isRunning) {

      logger.warn(`[${name}] Skipping ${context} run - previous batch still in progress`);

      return { skipped: true, reason: 'in_progress' };

    }



    isRunning = true;

    try {

      const runCallback = async () => onRun({ context });



      if (useLeaderLock && context === 'daily') {

        const dateKey = getDateKeyInTimeZone(ClockService.now(), timeZone);

        return await withSchedulerLeaderLock(name, dateKey, runCallback);

      }



      return await runCallback();

    } catch (error) {

      logger.error(`[${name}] ${context} run failed:`, error?.message || error);

      throw error;

    } finally {

      isRunning = false;

    }

  };



  const scheduleNext = () => {

    const delay = SchedulerUtil.msUntilNextDailyRun(hour, minute, timeZone);

    schedulerTimer = setTimeout(async () => {

      try {

        await executeRun('daily');

      } catch {

        // already logged

      } finally {

        scheduleNext();

      }

    }, delay);



    if (typeof schedulerTimer.unref === 'function') {

      schedulerTimer.unref();

    }

  };



  if (!skipStartupRun && startupDelayMs > 0) {

    startupTimer = setTimeout(async () => {

      try {

        await executeRun('startup');

      } catch {

        // already logged

      }

    }, startupDelayMs);

    if (typeof startupTimer.unref === 'function') {

      startupTimer.unref();

    }

  }



  scheduleNext();



  const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${timeZone}`;

  logger.info(

    `[${name}] Started (daily at ${label}${skipStartupRun ? ', startup run skipped' : `, startup delay ${startupDelayMs}ms`})`

  );



  return {

    stop: () => {

      if (schedulerTimer) clearTimeout(schedulerTimer);

      if (startupTimer) clearTimeout(startupTimer);

    },

  };

}



/**

 * Hourly timer that invokes onRun only when at least one billing timezone is at local midnight.

 * Used for HOA invoice reminders, next-year generation, and similar property-local jobs.

 */

function startHourlyPropertyMidnightRun({

  name,

  enabled = true,

  skipStartupRun = false,

  startupDelayMs = 0,

  onRun,

}) {

  if (!enabled) {

    logger.info(`[${name}] Disabled via configuration`);

    return { stop: () => {} };

  }



  if (typeof onRun !== 'function') {

    throw new Error(`[${name}] onRun callback is required`);

  }



  let schedulerTimer = null;

  let startupTimer = null;

  let isRunning = false;



  const executeRun = async (context = 'hourly') => {

    if (isRunning) {

      logger.warn(`[${name}] Skipping ${context} run - previous batch still in progress`);

      return { skipped: true, reason: 'in_progress' };

    }



    isRunning = true;

    try {

      const now = ClockService.now();

      const midnightZones = getBillingTimezonesAtLocalHour(0, now);

      if (midnightZones.length === 0) {

        return { skipped: true, reason: 'no_midnight_zones', midnightZones };

      }

      return await onRun({ midnightZones, now, context });

    } catch (error) {

      logger.error(`[${name}] ${context} run failed:`, error?.message || error);

      throw error;

    } finally {

      isRunning = false;

    }

  };



  const scheduleNext = () => {

    const delay = SchedulerUtil.msUntilNextHourlyRun();

    schedulerTimer = setTimeout(async () => {

      try {

        await executeRun('hourly');

      } catch {

        // already logged

      } finally {

        scheduleNext();

      }

    }, delay);



    if (typeof schedulerTimer.unref === 'function') {

      schedulerTimer.unref();

    }

  };



  if (!skipStartupRun && startupDelayMs > 0) {

    startupTimer = setTimeout(async () => {

      try {

        await executeRun('startup');

      } catch {

        // already logged

      }

    }, startupDelayMs);

    if (typeof startupTimer.unref === 'function') {

      startupTimer.unref();

    }

  }



  scheduleNext();

  logger.info(`[${name}] Started (hourly, property-local midnight buckets)`);



  return {

    stop: () => {

      if (schedulerTimer) clearTimeout(schedulerTimer);

      if (startupTimer) clearTimeout(startupTimer);

    },

  };

}



module.exports = {

  startScheduledDailyRun,

  startHourlyPropertyMidnightRun,

};

