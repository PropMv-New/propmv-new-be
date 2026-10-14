'use strict';

const ClockService = require('../services/clock.service');
const {
  TIMEZONE,
  FORMAT,
  MS_PER_DAY,
} = require('../constants/date.constants');

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerceDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function utcCalendarYmd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Calendar YYYY-MM-DD for filter/query bounds.
 * Joi `date().iso()` turns "YYYY-MM-DD" into UTC midnight; reading that through
 * America/New_York shifts the day back and excludes the intended end date (e.g. YTD "today").
 * UTC midnight / noon anchors keep the UTC calendar day.
 */
function calendarDateKeyFromFilterValue(value, timeZone = TIMEZONE.BUSINESS) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATE_ONLY_RE.test(trimmed)) return trimmed;
  }
  const date = coerceDate(value);
  if (!date) return null;
  const isUtcMidnight =
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  const isNoonUtc =
    date.getUTCHours() === 12 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  if (isUtcMidnight || isNoonUtc) {
    return utcCalendarYmd(date);
  }
  return getDateKeyInTimeZone(date, timeZone);
}

function getDateKeyInTimeZone(value, timeZone = TIMEZONE.BUSINESS) {
  const date = coerceDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function parseDateOnlyToNoonUtc(dateOnly) {
  const [yearStr, monthStr, dayStr] = String(dateOnly).split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function parseAppYmd(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0, 12, 0, 0, 0)).getUTCDate();
}

function shiftYmdDays(ymd, deltaDays, timeZone = TIMEZONE.BUSINESS) {
  const base = parseDateOnlyToNoonUtc(ymd);
  if (!base) return ymd;
  const shifted = new Date(base);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return getDateKeyInTimeZone(shifted, timeZone) || ymd;
}

/**
 * UTC instant for a wall-clock time on a calendar day in the business timezone.
 * Handles DST spring-forward / fall-back via iterative Intl correction.
 */
function calendarDateTimeInTimezoneToUtc(ymd, hour, minute = 0, second = 0, timeZone = TIMEZONE.BUSINESS) {
  const p = parseAppYmd(ymd);
  if (!p) return ClockService.now();

  const targetMs = Date.UTC(p.y, p.m - 1, p.d, hour, minute, second);

  const readParts = (date) => {
    const out = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).forEach(({ type, value }) => {
      if (type !== 'literal') out[type] = Number(value);
    });
    if (out.hour === 24) {
      out.hour = 0;
      const rolled = new Date(Date.UTC(out.year, out.month - 1, out.day + 1));
      out.year = rolled.getUTCFullYear();
      out.month = rolled.getUTCMonth() + 1;
      out.day = rolled.getUTCDate();
    }
    return out;
  };

  let guess = targetMs;
  for (let i = 0; i < 6; i += 1) {
    const parts = readParts(new Date(guess));
    const observedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = targetMs - observedMs;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

const DateUtil = {
  /** Current UTC instant. */
  nowUtc() {
    return ClockService.now();
  },

  nowEpoch() {
    return ClockService.nowEpoch();
  },

  /**
   * Current instant (Date objects are always UTC internally).
   * Calendar operations in business timezone use startOfDayEST / getDateKey helpers.
   */
  nowEST() {
    return ClockService.now();
  },

  /** Parse any value to a valid UTC Date or null. */
  toUTC(value) {
    return coerceDate(value);
  },

  /**
   * YYYY-MM-DD calendar key for value in America/New_York.
   * @returns {string|null}
   */
  toEST(value) {
    return getDateKeyInTimeZone(value, TIMEZONE.BUSINESS);
  },

  /** Noon-UTC anchor for the calendar day of value in EST. */
  startOfDayEST(value, timeZone = TIMEZONE.BUSINESS) {
    const key = calendarDateKeyFromFilterValue(value, timeZone);
    if (!key) return null;
    return parseDateOnlyToNoonUtc(key);
  },

  /** Last millisecond of calendar day (ymd string or Date) in EST. */
  endOfDayEST(value, timeZone = TIMEZONE.BUSINESS) {
    const key = calendarDateKeyFromFilterValue(value, timeZone);
    if (!key) return null;
    const nextDay = shiftYmdDays(key, 1, timeZone);
    const nextStart = parseDateOnlyToNoonUtc(nextDay);
    if (!nextStart) return null;
    return new Date(nextStart.getTime() - 1);
  },

  startOfMonthEST(value, timeZone = TIMEZONE.BUSINESS) {
    const key = getDateKeyInTimeZone(value ?? ClockService.now(), timeZone);
    if (!key) return null;
    const p = parseAppYmd(key);
    if (!p) return null;
    return parseDateOnlyToNoonUtc(`${p.y}-${String(p.m).padStart(2, '0')}-01`);
  },

  endOfMonthEST(value, timeZone = TIMEZONE.BUSINESS) {
    const start = this.startOfMonthEST(value, timeZone);
    if (!start) return null;
    const key = getDateKeyInTimeZone(start, timeZone);
    const p = parseAppYmd(key);
    if (!p) return null;
    const last = lastDayOfMonth(p.y, p.m);
    return parseDateOnlyToNoonUtc(`${p.y}-${String(p.m).padStart(2, '0')}-${String(last).padStart(2, '0')}`);
  },

  addDays(value, days) {
    const date = coerceDate(value) ?? ClockService.now();
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  },

  subtractDays(value, days) {
    return this.addDays(value, -days);
  },

  diffDays(a, b) {
    const start = this.startOfDayEST(a);
    const end = this.startOfDayEST(b);
    if (!start || !end) return 0;
    return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
  },

  isToday(value, referenceDate = ClockService.now(), timeZone = TIMEZONE.BUSINESS) {
    const key = getDateKeyInTimeZone(value, timeZone);
    const refKey = getDateKeyInTimeZone(referenceDate, timeZone);
    return Boolean(key && refKey && key === refKey);
  },

  isPast(value, referenceDate = ClockService.now(), timeZone = TIMEZONE.BUSINESS) {
    const key = getDateKeyInTimeZone(value, timeZone);
    const refKey = getDateKeyInTimeZone(referenceDate, timeZone);
    return Boolean(key && refKey && key < refKey);
  },

  isFuture(value, referenceDate = ClockService.now(), timeZone = TIMEZONE.BUSINESS) {
    const key = getDateKeyInTimeZone(value, timeZone);
    const refKey = getDateKeyInTimeZone(referenceDate, timeZone);
    return Boolean(key && refKey && key > refKey);
  },

  formatUTC(value, options = {}) {
    const date = coerceDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE.UTC,
      ...FORMAT.DEFAULT_UI_DATETIME,
      ...options,
    }).format(date);
  },

  formatEST(value, options = {}) {
    const date = coerceDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE.BUSINESS,
      ...FORMAT.DEFAULT_UI_DATETIME,
      ...options,
    }).format(date);
  },

  /** Date-only in business timezone: "Jul 01, 2027" */
  formatESTDate(value, options = {}) {
    const date = coerceDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE.BUSINESS,
      ...FORMAT.DEFAULT_UI_DATE,
      ...options,
    }).format(date);
  },

  toEpoch(value) {
    const date = coerceDate(value);
    return date ? date.getTime() : null;
  },

  fromEpoch(ms) {
    if (ms == null || Number.isNaN(Number(ms))) return null;
    return new Date(Number(ms));
  },

  /** ISO-8601 UTC string for API responses. */
  toISO(value) {
    const date = coerceDate(value);
    return date ? date.toISOString() : null;
  },

  /** YYYY-MM-DD portion of a stored UTC instant (for exports and CSV). */
  toDateOnlyISO(value) {
    const iso = this.toISO(value);
    return iso ? iso.split('T')[0] : '';
  },

  /** Sortable export filename timestamp in the business timezone. */
  buildExportFilenameTimestamp(referenceDate = ClockService.now(), timeZone = TIMEZONE.BUSINESS) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(referenceDate);
    const pick = (type) => parts.find((p) => p.type === type)?.value || '00';
    return `${pick('year')}${pick('month')}${pick('day')}_${pick('hour')}${pick('minute')}${pick('second')}`;
  },

  getDateKeyInTimeZone,
  calendarDateKeyFromFilterValue,
  parseDateOnlyToNoonUtc,
  parseAppYmd,
  calendarDateTimeInTimezoneToUtc,
  shiftYmdDays,
};

module.exports = DateUtil;
