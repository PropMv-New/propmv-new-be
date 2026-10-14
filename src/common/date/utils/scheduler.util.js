'use strict';

const ClockService = require('../services/clock.service');
const DateUtil = require('./date.util');
const { TIMEZONE, MS_PER_DAY } = require('../constants/date.constants');

/**
 * Read calendar parts for an instant in a specific IANA timezone.
 * Used by schedulers - never rely on server local timezone.
 */
function getDatePartsInTimeZone(date, timeZone = TIMEZONE.BUSINESS) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let hour = Number(lookup.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

/**
 * Milliseconds until the next daily run at hour:minute in the business timezone.
 * Handles DST correctly via iterative Intl correction.
 *
 * @param {number} hour - 0-23 in business timezone
 * @param {number} [minute=0]
 * @param {string} [timeZone=TIMEZONE.BUSINESS]
 * @returns {number}
 */
function msUntilNextDailyRun(hour, minute = 0, timeZone = TIMEZONE.BUSINESS) {
  const now = ClockService.now();
  const current = getDatePartsInTimeZone(now, timeZone);
  const todayYmd = DateUtil.toEST(now);

  let targetYmd = todayYmd;
  if (
    current.hour > hour ||
    (current.hour === hour && current.minute >= minute)
  ) {
    targetYmd = DateUtil.shiftYmdDays(todayYmd, 1, timeZone);
  }

  let nextRun = DateUtil.calendarDateTimeInTimezoneToUtc(targetYmd, hour, minute, 0, timeZone);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const parts = getDatePartsInTimeZone(nextRun, timeZone);
    if (parts.hour === hour && parts.minute === minute) break;
    const deltaMinutes = (hour - parts.hour) * 60 + (minute - parts.minute);
    nextRun = new Date(nextRun.getTime() + deltaMinutes * 60 * 1000);
  }

  const delay = nextRun.getTime() - now.getTime();
  return delay > 0 ? delay : MS_PER_DAY;
}

/**
 * Milliseconds until the next matching slot from a list of ET hours on a given minute.
 * @param {number[]} runHours - hours in business timezone (e.g. [4, 16])
 * @param {number} runMinute
 * @param {string} [timeZone=TIMEZONE.BUSINESS]
 */
function msUntilNextScheduledRuns(runHours, runMinute = 0, timeZone = TIMEZONE.BUSINESS) {
  const now = ClockService.now();
  const current = getDatePartsInTimeZone(now, timeZone);
  const candidates = [];

  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    runHours.forEach((hour) => {
      const baseYmd = DateUtil.shiftYmdDays(DateUtil.toEST(now), dayOffset, timeZone);
      const candidate = DateUtil.calendarDateTimeInTimezoneToUtc(baseYmd, hour, runMinute, 0, timeZone);
      if (candidate.getTime() > now.getTime()) {
        candidates.push(candidate.getTime());
      }
    });
  }

  if (candidates.length === 0) {
    const tomorrowYmd = DateUtil.shiftYmdDays(DateUtil.toEST(now), 1, timeZone);
    const firstHour = Math.min(...runHours);
    return DateUtil.calendarDateTimeInTimezoneToUtc(tomorrowYmd, firstHour, runMinute, 0, timeZone).getTime() - now.getTime();
  }

  return Math.min(...candidates) - now.getTime();
}

/**
 * Milliseconds until the next top-of-hour (UTC-aligned wall clock hour).
 * @returns {number}
 */
function msUntilNextHourlyRun() {
  const now = ClockService.now();
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1);
  const delay = nextHour.getTime() - now.getTime();
  return delay > 0 ? delay : 60 * 60 * 1000;
}

module.exports = {
  getDatePartsInTimeZone,
  msUntilNextDailyRun,
  msUntilNextScheduledRuns,
  msUntilNextHourlyRun,
};
