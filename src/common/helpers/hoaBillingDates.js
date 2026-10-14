/**
 * ------------------------------------------------------------------
 * File: hoaBillingDates.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaBillingDates.
 *
 * Used By:
 * invoiceLifecycleEmail.service, invoiceNotificationEmailHelper, maintenanceEmailHelper, ownerRemovalNoticeEmailHelper
 * ------------------------------------------------------------------
 */
'use strict';

const { ClockService, DateUtil, TIMEZONE, TIMEZONE_LABEL, MONGO_DATE_EXPR_TIMEZONE } = require('../date');

/**
 * Canonical application calendar timezone (Richmond, VA / US East).
 * All HOA billing, due dates, late fees, and invoice calendar logic use this zone.
 * IANA zone for Mongo $dateToString must use standard casing (America/New_York).
 *
 * @deprecated Prefer importing from `common/date` directly. This module remains
 * for HOA domain helpers during incremental migration.
 */
const APP_TIMEZONE = TIMEZONE.BUSINESS;
/** Canonical business timezone (Richmond, VA office). Alias of APP_TIMEZONE. */
const BUSINESS_TIMEZONE = APP_TIMEZONE;

const HOA_MONGO_TIMEZONE_FOR_DATE_EXPR = MONGO_DATE_EXPR_TIMEZONE;

const APP_TIMEZONE_LABEL = TIMEZONE_LABEL.BUSINESS;

/**
 * get Date Key In Time Zone
 *
 * Performs logic operations for getDateKeyInTimeZone.
 *
 * @param value - Request/input argument
 * @param timeZone - Request/input argument
 * @returns Operations result
 */
function getDateKeyInTimeZone(value, timeZone = APP_TIMEZONE) {
  return DateUtil.getDateKeyInTimeZone(value, timeZone);
}

/**
 * parse Date Only To Noon Utc
 *
 * Performs logic operations for parseDateOnlyToNoonUtc.
 *
 * @param dateOnly - Request/input argument
 * @returns Operations result
 */
function parseDateOnlyToNoonUtc(dateOnly) {
  return DateUtil.parseDateOnlyToNoonUtc(dateOnly);
}

/**
 * Resolve billing YMD from a stored Date. Joi/API often persist YYYY-MM-DD as UTC midnight;
 * use the UTC calendar day (not APP_TIMEZONE shift) so "June 1" stays June 1.
 */
function dateOnlyKeyFromStoredInstant(value, timeZone = APP_TIMEZONE) {
  return DateUtil.calendarDateKeyFromFilterValue(value, timeZone);
}

/**
 * Canonical YMD for HOA billing anchors (dueDate, balanceAsOf, ownership calendar days).
 * Prefer UTC calendar day for midnight/noon stored dates so Aug 10T00:00Z stays Aug 10
 * (same rule as ownership `toDateAtStartOfDay` / UI `toBillingCalendarYmd`).
 */
function billingCalendarDateKey(value, timeZone = APP_TIMEZONE) {
  if (value == null || value === '') return null;
  return dateOnlyKeyFromStoredInstant(value, timeZone) || getDateKeyInTimeZone(value, timeZone);
}

/** Calendar-day anchor at noon UTC for the given instant in APP_TIMEZONE (not server local). */
function normalizeDateToStartOfDay(value, timeZone = APP_TIMEZONE) {
  return DateUtil.startOfDayEST(value, timeZone);
}

/**
 * get Today Anchor In Time Zone
 *
 * Performs logic operations for getTodayAnchorInTimeZone.
 *
 * @param timeZone - Request/input argument
 * @returns Operations result
 */
function getTodayAnchorInTimeZone(timeZone = APP_TIMEZONE) {
  const todayKey = getDateKeyInTimeZone(ClockService.now(), timeZone);
  return todayKey ? parseDateOnlyToNoonUtc(todayKey) : null;
}

/**
 * get Today Start And Tomorrow Start
 *
 * Performs logic operations for getTodayStartAndTomorrowStart.
 *
 * @param timeZone - Request/input argument
 * @returns Operations result
 */
function getTodayStartAndTomorrowStart(timeZone = APP_TIMEZONE) {
  const todayKey = getDateKeyInTimeZone(ClockService.now(), timeZone);
  if (!todayKey) {
    const fallback = getTodayAnchorInTimeZone(timeZone) || normalizeDateToStartOfDay(ClockService.now(), timeZone);
    return { todayStart: fallback, tomorrowStart: null };
  }
  const todayStart = parseDateOnlyToNoonUtc(todayKey);
  if (!todayStart) {
    const fallback = getTodayAnchorInTimeZone(timeZone) || normalizeDateToStartOfDay(ClockService.now(), timeZone);
    return { todayStart: fallback, tomorrowStart: null };
  }
  const tomorrowStart = DateUtil.addDays(todayStart, 1);
  return { todayStart, tomorrowStart };
}

/** Calendar compare in APP_TIMEZONE: -1 past, 0 today, 1 future */
function compareCalendarDateToToday(dueDate, referenceDate = ClockService.now(), timeZone = APP_TIMEZONE) {
  const dueKey = billingCalendarDateKey(dueDate, timeZone);
  const refKey = billingCalendarDateKey(referenceDate, timeZone);
  if (!dueKey || !refKey) return 0;
  if (dueKey < refKey) return -1;
  if (dueKey > refKey) return 1;
  return 0;
}

/**
 * is Due Date On Or Before Today
 *
 * Performs logic operations for isDueDateOnOrBeforeToday.
 *
 * @param dueDate - Request/input argument
 * @param referenceDate - Request/input argument
 * @returns Operations result
 */
function isDueDateOnOrBeforeToday(dueDate, referenceDate = ClockService.now(), timeZone = APP_TIMEZONE) {
  return compareCalendarDateToToday(dueDate, referenceDate, timeZone) <= 0;
}

/**
 * is Due Date Strictly After Today
 *
 * Performs logic operations for isDueDateStrictlyAfterToday.
 *
 * @param dueDate - Request/input argument
 * @param referenceDate - Request/input argument
 * @returns Operations result
 */
function isDueDateStrictlyAfterToday(dueDate, referenceDate = ClockService.now(), timeZone = APP_TIMEZONE) {
  return compareCalendarDateToToday(dueDate, referenceDate, timeZone) > 0;
}

/** Raw Pending row is overdue when its due *calendar day* (in TZ) is before today */
function isDerivedInvoiceOverduePending(invoice, pendingStatusLabel = 'Pending', timeZone = APP_TIMEZONE) {
  if (!invoice || String(invoice.status) !== String(pendingStatusLabel)) return false;
  return compareCalendarDateToToday(invoice.dueDate, ClockService.now(), timeZone) < 0;
}

/**
 * Invoice contributes to overdue KPI when its due calendar day is before today and balance remains,
 * regardless of payment-processing state (Processing, Partially Paid, etc.).
 * Paid and fully waived invoices contribute $0.
 */
function isPastDueOutstandingInvoice(invoice, referenceDate = ClockService.now(), timeZone = APP_TIMEZONE) {
  if (!invoice) return false;

  const balanceDue = Number(invoice.balanceDue || 0);
  if (balanceDue <= 0) return false;

  const st = String(invoice.status || '');
  if (st === 'Paid' || st === 'Waived') return false;

  const waivedAmount = Number(invoice.waivedAmount || 0);
  const processingAmount = Number(invoice.processingAmount || 0);
  const alreadyPaid = Number(invoice.alreadyPaid || 0);
  if (waivedAmount > 0 && balanceDue <= 0 && processingAmount <= 0 && alreadyPaid <= 0) {
    return false;
  }

  return compareCalendarDateToToday(invoice.dueDate, referenceDate, timeZone) < 0;
}

/** Whole calendar days late in APP_TIMEZONE (0 if due today or future). */
function getCalendarDaysLate(dueDate, referenceDate = ClockService.now(), timeZone = APP_TIMEZONE) {
  const dueKey = billingCalendarDateKey(dueDate, timeZone);
  const refKey = billingCalendarDateKey(referenceDate, timeZone);
  if (!dueKey || !refKey || refKey <= dueKey) return 0;
  const dueMs = parseDateOnlyToNoonUtc(dueKey)?.getTime();
  const refMs = parseDateOnlyToNoonUtc(refKey)?.getTime();
  if (dueMs == null || refMs == null) return 0;
  return Math.floor((refMs - dueMs) / (1000 * 60 * 60 * 24));
}

/**
 * format Date In App Timezone
 *
 * Performs logic operations for formatDateInAppTimezone.
 *
 * @param value - Request/input argument
 * @param options - Request/input argument
 * @param timeZone - Request/input argument
 * @returns Operations result
 */
function formatDateInAppTimezone(value, options = {}, timeZone = APP_TIMEZONE) {
  if (!value) return '';
  const billingKey = billingCalendarDateKey(value, timeZone);
  const displayValue = billingKey ? (parseDateOnlyToNoonUtc(billingKey) || value) : value;
  return DateUtil.formatESTDate(displayValue, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    ...options,
  });
}

/** User-friendly date for email templates: "Jul 01, 2027" */
function formatEmailDate(value, options = {}) {
  return formatDateInAppTimezone(value, options);
}

/** User-friendly datetime for email templates: "Jul 01, 2027, 08:00 AM" */
function formatEmailDateTime(value, options = {}) {
  return formatDateTimeInAppTimezone(value, options);
}

/**
 * format Date Time In App Timezone
 *
 * Performs logic operations for formatDateTimeInAppTimezone.
 *
 * @param value - Request/input argument
 * @param options - Request/input argument
 * @param timeZone - Request/input argument
 * @returns Operations result
 */
function formatDateTimeInAppTimezone(value, options = {}, timeZone = APP_TIMEZONE) {
  if (!value) return '';
  return DateUtil.formatEST(value, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  });
}

/**
 * format Month Year In App Timezone
 *
 * Performs logic operations for formatMonthYearInAppTimezone.
 *
 * @param value - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function formatMonthYearInAppTimezone(value, options = {}) {
  const billingKey = billingCalendarDateKey(value);
  const date = billingKey
    ? (parseDateOnlyToNoonUtc(billingKey) || DateUtil.toUTC(value))
    : DateUtil.toUTC(value);
  if (!date) return 'N/A';
  // Month/year only - do not use formatEST (defaults include day + time).
  return new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    month: options.longMonth ? 'long' : 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * to Api Date Only In App Timezone
 *
 * Performs logic operations for toApiDateOnlyInAppTimezone.
 *
 * @param value - Request/input argument
 * @param timeZone - Request/input argument
 * @returns Operations result
 */
function toApiDateOnlyInAppTimezone(value, timeZone = APP_TIMEZONE) {
  return billingCalendarDateKey(value, timeZone);
}

/**
 * parse App Ymd
 *
 * Performs logic operations for parseAppYmd.
 *
 * @param ymd - Request/input argument
 * @returns Operations result
 */
function parseAppYmd(ymd) {
  return DateUtil.parseAppYmd(ymd);
}

/**
 * last Day Of App Month
 *
 * Performs logic operations for lastDayOfAppMonth.
 *
 * @param y - Request/input argument
 * @param m - Request/input argument
 * @returns Operations result
 */
function lastDayOfAppMonth(y, m) {
  return new Date(Date.UTC(y, m, 0, 12, 0, 0, 0)).getUTCDate();
}

/**
 * shift App Ymd Days
 *
 * Performs logic operations for shiftAppYmdDays.
 *
 * @param ymd - Request/input argument
 * @param deltaDays - Request/input argument
 * @returns Operations result
 */
function shiftAppYmdDays(ymd, deltaDays) {
  return DateUtil.shiftYmdDays(ymd, deltaDays, APP_TIMEZONE);
}

/**
 * Shift a YYYY-MM-DD calendar key by N months (clamps day to month length).
 * @param {string} ymd
 * @param {number} deltaMonths
 * @returns {string}
 */
function shiftAppYmdMonths(ymd, deltaMonths) {
  const p = parseAppYmd(ymd);
  if (!p) return ymd;
  let y = p.y;
  let m = p.m + Number(deltaMonths || 0);
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  const d = Math.min(p.d, lastDayOfAppMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Inclusive date range for the N months immediately preceding a tenure start date.
 * Example: tenure starts 2026-06-01, months=3 → 2026-03-01 .. 2026-05-31
 *
 * @param {string} tenureStartYmd YYYY-MM-DD start of the selected dashboard period
 * @param {number} [months=3]
 * @returns {{ startYmd: string, endYmd: string } | null}
 */
function resolvePrecedingMonthsRange(tenureStartYmd, months = 3) {
  const startKey = String(tenureStartYmd || '').trim();
  if (!parseAppYmd(startKey)) return null;
  const monthCount = Math.max(1, Number(months) || 3);
  const startYmd = shiftAppYmdMonths(startKey, -monthCount);
  const endYmd = shiftAppYmdDays(startKey, -1);
  if (!startYmd || !endYmd || endYmd < startYmd) return null;
  return { startYmd, endYmd };
}

/**
 * get Today Ymd In App Timezone
 *
 * Performs logic operations for getTodayYmdInAppTimezone.
 *
 * @returns Operations result
 */
function getTodayYmdInAppTimezone() {
  return getDateKeyInTimeZone(ClockService.now()) || '';
}

/**
 * eastern Today Parts
 *
 * Performs logic operations for easternTodayParts.
 *
 * @returns Operations result
 */
function easternTodayParts() {
  const p = parseAppYmd(getTodayYmdInAppTimezone());
  if (!p) throw new Error('Unable to resolve today in app timezone');
  return p;
}

/** True when start/end YMD match the canonical this_month preset in APP_TIMEZONE. */
function isThisMonthDateRangeKeys(startYmd, endYmd, timeZone = APP_TIMEZONE) {
  if (!startYmd || !endYmd) return false;
  const startKey = String(startYmd).trim();
  const endKey = String(endYmd).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(endKey)) {
    return false;
  }
  const range = resolveDateRangePreset('this_month');
  const monthStartKey = billingCalendarDateKey(range.start, timeZone);
  const monthEndKey = billingCalendarDateKey(range.end, timeZone);
  return startKey === monthStartKey && endKey === monthEndKey;
}

/**
 * resolve Date Range Preset
 *
 * Performs logic operations for resolveDateRangePreset.
 *
 * @param presetValue - Request/input argument
 * @returns Operations result
 */
function resolveDateRangePreset(presetValue) {
  const { y, m, d } = easternTodayParts();
  const todayYmd = getTodayYmdInAppTimezone();

  switch (presetValue) {
    case 'all':
      throw new Error('resolveDateRangePreset: "all" is open-ended - handle at the call site');
    case 'today':
      return {
        start: parseDateOnlyToNoonUtc(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
        end: parseDateOnlyToNoonUtc(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`),
      };
    case 'last_7_days':
      return {
        start: parseDateOnlyToNoonUtc(shiftAppYmdDays(todayYmd, -6)),
        end: parseDateOnlyToNoonUtc(todayYmd),
      };
    case 'last_30_days':
      return {
        start: parseDateOnlyToNoonUtc(shiftAppYmdDays(todayYmd, -29)),
        end: parseDateOnlyToNoonUtc(todayYmd),
      };
    case 'this_month':
      return {
        start: parseDateOnlyToNoonUtc(`${y}-${String(m).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${y}-${String(m).padStart(2, '0')}-${String(lastDayOfAppMonth(y, m)).padStart(2, '0')}`),
      };
    case 'last_month': {
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      return {
        start: parseDateOnlyToNoonUtc(`${ly}-${String(lm).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${ly}-${String(lm).padStart(2, '0')}-${String(lastDayOfAppMonth(ly, lm)).padStart(2, '0')}`),
      };
    }
    case 'next_month': {
      const nm = m === 12 ? 1 : m + 1;
      const ny = m === 12 ? y + 1 : y;
      return {
        start: parseDateOnlyToNoonUtc(`${ny}-${String(nm).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${ny}-${String(nm).padStart(2, '0')}-${String(lastDayOfAppMonth(ny, nm)).padStart(2, '0')}`),
      };
    }
    case 'this_quarter': {
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      const qEndMonth = qStartMonth + 2;
      return {
        start: parseDateOnlyToNoonUtc(`${y}-${String(qStartMonth).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${y}-${String(qEndMonth).padStart(2, '0')}-${String(lastDayOfAppMonth(y, qEndMonth)).padStart(2, '0')}`),
      };
    }
    case 'last_quarter': {
      const q = Math.floor((m - 1) / 3);
      let lastQ = q - 1;
      let yAdj = y;
      if (lastQ < 0) {
        lastQ = 3;
        yAdj = y - 1;
      }
      const startM = lastQ * 3 + 1;
      const endM = startM + 2;
      return {
        start: parseDateOnlyToNoonUtc(`${yAdj}-${String(startM).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${yAdj}-${String(endM).padStart(2, '0')}-${String(lastDayOfAppMonth(yAdj, endM)).padStart(2, '0')}`),
      };
    }
    case 'last_3_months': {
      const startM = m - 2 <= 0 ? m - 2 + 12 : m - 2;
      const startY = m - 2 <= 0 ? y - 1 : y;
      return {
        start: parseDateOnlyToNoonUtc(`${startY}-${String(startM).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${y}-${String(m).padStart(2, '0')}-${String(lastDayOfAppMonth(y, m)).padStart(2, '0')}`),
      };
    }
    case 'last_6_months': {
      const startM = m - 5 <= 0 ? m - 5 + 12 : m - 5;
      const startY = m - 5 <= 0 ? y - 1 : y;
      return {
        start: parseDateOnlyToNoonUtc(`${startY}-${String(startM).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${y}-${String(m).padStart(2, '0')}-${String(lastDayOfAppMonth(y, m)).padStart(2, '0')}`),
      };
    }
    case 'next_6_months': {
      const endM = m + 6 > 12 ? m + 6 - 12 : m + 6;
      const endY = m + 6 > 12 ? y + 1 : y;
      const startM = m === 12 ? 1 : m + 1;
      const startY = m === 12 ? y + 1 : y;
      return {
        start: parseDateOnlyToNoonUtc(`${startY}-${String(startM).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${endY}-${String(endM).padStart(2, '0')}-${String(lastDayOfAppMonth(endY, endM)).padStart(2, '0')}`),
      };
    }
    case 'year_to_date':
      // Inclusive: Jan 1 .. today. Filter with $gte start and $lte end-of-day(today).
      return {
        start: parseDateOnlyToNoonUtc(`${y}-01-01`),
        end: parseDateOnlyToNoonUtc(todayYmd),
      };
    case 'last_year':
      return {
        start: parseDateOnlyToNoonUtc(`${y - 1}-01-01`),
        end: parseDateOnlyToNoonUtc(`${y - 1}-12-31`),
      };
    case 'custom':
    default: {
      const startM = m - 2 <= 0 ? m - 2 + 12 : m - 2;
      const startY = m - 2 <= 0 ? y - 1 : y;
      return {
        start: parseDateOnlyToNoonUtc(`${startY}-${String(startM).padStart(2, '0')}-01`),
        end: parseDateOnlyToNoonUtc(`${y}-${String(m).padStart(2, '0')}-${String(lastDayOfAppMonth(y, m)).padStart(2, '0')}`),
      };
    }
  }
}

/**
 * get End Of Day In App Timezone
 *
 * Performs logic operations for getEndOfDayInAppTimezone.
 *
 * @param ymd - Request/input argument
 * @returns Operations result
 */
function getEndOfDayInAppTimezone(ymd) {
  return DateUtil.endOfDayEST(ymd, APP_TIMEZONE);
}

/** UTC instant for a wall-clock time on a calendar day in APP_TIMEZONE. */
function calendarDateTimeInAppTimezoneToUtc(ymd, hour, minute = 0, second = 0, timeZone = APP_TIMEZONE) {
  return DateUtil.calendarDateTimeInTimezoneToUtc(ymd, hour, minute, second, timeZone);
}

const PAYMENT_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve payment timestamps: preserve real clock time for today's payments;
 * date-only backdates anchor at noon APP_TIMEZONE (not noon UTC).
 */
function parsePaymentTimestamp(value, now = ClockService.now()) {
  if (value == null || value === '') return ClockService.now();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (PAYMENT_DATE_ONLY_RE.test(trimmed)) {
      const todayKey = getDateKeyInTimeZone(now);
      if (trimmed === todayKey) return ClockService.now();
      return calendarDateTimeInAppTimezoneToUtc(trimmed, 12, 0, 0);
    }
  }
  const parsed = DateUtil.toUTC(value);
  if (!parsed) return ClockService.now();
  return parsed;
}

/**
 * due Date String Expr Mongo
 *
 * Performs logic operations for dueDateStringExprMongo.
 *
 * @returns Operations result
 */
function dueDateStringExprMongo() {
  return {
    $dateToString: {
      format: '%Y-%m-%d',
      date: '$dueDate',
      timezone: HOA_MONGO_TIMEZONE_FOR_DATE_EXPR,
    },
  };
}

module.exports = {
  APP_TIMEZONE,
  BUSINESS_TIMEZONE,
  APP_TIMEZONE_LABEL,
  HOA_MONGO_TIMEZONE_FOR_DATE_EXPR,
  getDateKeyInTimeZone,
  dateOnlyKeyFromStoredInstant,
  billingCalendarDateKey,
  parseDateOnlyToNoonUtc,
  normalizeDateToStartOfDay,
  getTodayAnchorInTimeZone,
  getTodayStartAndTomorrowStart,
  compareCalendarDateToToday,
  isDueDateOnOrBeforeToday,
  isDueDateStrictlyAfterToday,
  isDerivedInvoiceOverduePending,
  isPastDueOutstandingInvoice,
  getCalendarDaysLate,
  formatDateInAppTimezone,
  formatEmailDate,
  formatEmailDateTime,
  formatDateTimeInAppTimezone,
  formatMonthYearInAppTimezone,
  toApiDateOnlyInAppTimezone,
  parseAppYmd,
  lastDayOfAppMonth,
  shiftAppYmdDays,
  shiftAppYmdMonths,
  resolvePrecedingMonthsRange,
  getTodayYmdInAppTimezone,
  resolveDateRangePreset,
  isThisMonthDateRangeKeys,
  getEndOfDayInAppTimezone,
  calendarDateTimeInAppTimezoneToUtc,
  parsePaymentTimestamp,
  dueDateStringExprMongo,
};
