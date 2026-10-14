'use strict';

const { ClockService, DateUtil, TIMEZONE } = require('../date');
const { getDatePartsInTimeZone } = require('../date/utils/scheduler.util');
const {
  billingCalendarDateKey,
  parseDateOnlyToNoonUtc,
} = require('./hoaBillingDates');
const { resolveBillingTimezone } = require('./billingTimezone.constants');

/** Whole calendar days late in the property billing timezone. */
function getCalendarDaysLateInTimezone(dueDate, referenceDate = ClockService.now(), timeZone) {
  const tz = resolveBillingTimezone(timeZone);
  const dueKey = billingCalendarDateKey(dueDate, tz);
  const refKey = billingCalendarDateKey(referenceDate, tz);
  if (!dueKey || !refKey || refKey <= dueKey) return 0;
  const dueMs = parseDateOnlyToNoonUtc(dueKey)?.getTime();
  const refMs = parseDateOnlyToNoonUtc(refKey)?.getTime();
  if (dueMs == null || refMs == null) return 0;
  return Math.floor((refMs - dueMs) / (1000 * 60 * 60 * 24));
}

function compareCalendarDateToTodayInTimezone(
  dueDate,
  referenceDate = ClockService.now(),
  timeZone
) {
  const tz = resolveBillingTimezone(timeZone);
  const dueKey = billingCalendarDateKey(dueDate, tz);
  const refKey = billingCalendarDateKey(referenceDate, tz);
  if (!dueKey || !refKey) return 0;
  if (dueKey < refKey) return -1;
  if (dueKey > refKey) return 1;
  return 0;
}

/** True when local hour in property TZ is 0 (midnight hour). Used by hourly scheduler. */
function isPropertyLocalMidnightHour(instant = ClockService.now(), timeZone) {
  const tz = resolveBillingTimezone(timeZone);
  const parts = getDatePartsInTimeZone(instant, tz);
  return parts.hour === 0;
}

/** YMD of grace period end (due date + grace calendar days) in property TZ. */
function getGracePeriodEndYmd(dueDate, graceDays, timeZone) {
  const tz = resolveBillingTimezone(timeZone);
  const dueKey = billingCalendarDateKey(dueDate, tz);
  if (!dueKey) return null;
  const grace = Math.max(0, Number(graceDays) || 0);
  return DateUtil.shiftYmdDays(dueKey, grace, tz);
}

/** First calendar day late fees may apply (grace end + 1) as YMD in property TZ. */
function getFirstLateFeeEligibleYmd(dueDate, graceDays, timeZone) {
  const graceEnd = getGracePeriodEndYmd(dueDate, graceDays, timeZone);
  if (!graceEnd) return null;
  const tz = resolveBillingTimezone(timeZone);
  return DateUtil.shiftYmdDays(graceEnd, 1, tz);
}

/** UTC instant of property-local midnight on first late-fee-eligible day. */
function getFirstLateFeeEligibleInstant(dueDate, graceDays, timeZone) {
  const ymd = getFirstLateFeeEligibleYmd(dueDate, graceDays, timeZone);
  if (!ymd) return null;
  const tz = resolveBillingTimezone(timeZone);
  return DateUtil.calendarDateTimeInTimezoneToUtc(ymd, 0, 0, 0, tz);
}

/** Whether reference instant is on or after first eligible property-local midnight. */
function isOnOrAfterFirstLateFeeEligibleInstant(dueDate, graceDays, timeZone, referenceInstant = ClockService.now()) {
  const eligible = getFirstLateFeeEligibleInstant(dueDate, graceDays, timeZone);
  if (!eligible) return false;
  return referenceInstant.getTime() >= eligible.getTime();
}

/** IANA zones currently at local hour (e.g. 0 for midnight) at the given instant. */
function getBillingTimezonesAtLocalHour(hour, instant = ClockService.now(), timezoneList) {
  const { US_BILLING_TIMEZONE_IANAS } = require('./billingTimezone.constants');
  const candidates = Array.isArray(timezoneList) && timezoneList.length > 0
    ? timezoneList
    : US_BILLING_TIMEZONE_IANAS;

  return candidates.filter((tz) => {
    try {
      const parts = getDatePartsInTimeZone(instant, tz);
      return parts.hour === hour;
    } catch {
      return false;
    }
  });
}

function resolvePropertyBillingTimezone(property) {
  return resolveBillingTimezone(property?.billingTimezone || TIMEZONE.BUSINESS);
}

module.exports = {
  getCalendarDaysLateInTimezone,
  compareCalendarDateToTodayInTimezone,
  isPropertyLocalMidnightHour,
  getGracePeriodEndYmd,
  getFirstLateFeeEligibleYmd,
  getFirstLateFeeEligibleInstant,
  isOnOrAfterFirstLateFeeEligibleInstant,
  getBillingTimezonesAtLocalHour,
  resolvePropertyBillingTimezone,
};
