'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClockService, DateUtil, TIMEZONE } = require('../index');

describe('ClockService', () => {
  afterEach(() => ClockService.reset());

  it('returns live time when not fixed', () => {
    const before = Date.now();
    const now = ClockService.now().getTime();
    const after = Date.now();
    assert.ok(now >= before && now <= after);
  });

  it('returns fixed time in tests', () => {
    ClockService.setFixedTime('2026-07-25T18:42:00.000Z');
    assert.equal(ClockService.now().toISOString(), '2026-07-25T18:42:00.000Z');
    assert.equal(ClockService.nowEpoch(), new Date('2026-07-25T18:42:00.000Z').getTime());
  });
});

describe('DateUtil', () => {
  afterEach(() => ClockService.reset());

  it('toISO returns UTC ISO string', () => {
    assert.equal(DateUtil.toISO('2026-07-25T18:42:00.000Z'), '2026-07-25T18:42:00.000Z');
  });

  it('toEST returns YYYY-MM-DD in America/New_York', () => {
    // 2026-07-25 18:42 UTC = 2026-07-25 14:42 ET (EDT)
    assert.equal(DateUtil.toEST('2026-07-25T18:42:00.000Z'), '2026-07-25');
    // 2026-07-25 04:00 UTC = 2026-07-25 00:00 ET
    assert.equal(DateUtil.toEST('2026-07-25T04:00:00.000Z'), '2026-07-25');
    // 2026-07-25 03:59 UTC = 2026-07-24 23:59 ET
    assert.equal(DateUtil.toEST('2026-07-25T03:59:00.000Z'), '2026-07-24');
  });

  it('startOfDayEST anchors at noon UTC for calendar day', () => {
    const start = DateUtil.startOfDayEST('2026-07-25T18:42:00.000Z');
    assert.equal(start.toISOString(), '2026-07-25T12:00:00.000Z');
  });

  it('startOfDayEST treats YYYY-MM-DD as a business-timezone calendar date', () => {
    const start = DateUtil.startOfDayEST('2026-07-25');
    assert.equal(start.toISOString(), '2026-07-25T12:00:00.000Z');
  });

  it('startOfDayEST/endOfDayEST keep UTC-midnight date-only Days (Joi iso) on the same calendar day', () => {
    // Joi.date().iso() parses "2026-08-23" as 2026-08-23T00:00:00.000Z
    const joiParsedEnd = new Date('2026-08-23T00:00:00.000Z');
    assert.equal(DateUtil.calendarDateKeyFromFilterValue(joiParsedEnd), '2026-08-23');
    // Without calendar-key handling, America/New_York would shift this to 2026-08-22
    assert.notEqual(DateUtil.getDateKeyInTimeZone(joiParsedEnd), '2026-08-23');

    const start = DateUtil.startOfDayEST(new Date('2026-01-01T00:00:00.000Z'));
    const end = DateUtil.endOfDayEST(joiParsedEnd);
    assert.equal(start.toISOString(), '2026-01-01T12:00:00.000Z');
    // Noon-anchored due dates on the end day must be included ($lte end-of-day bound)
    const dueTodayNoon = new Date('2026-08-23T12:00:00.000Z');
    assert.ok(dueTodayNoon.getTime() >= start.getTime());
    assert.ok(dueTodayNoon.getTime() <= end.getTime());
  });

  it('year_to_date style range is inclusive of Jan 1 and today via start/end of day', () => {
    ClockService.setFixedTime('2026-08-23T18:00:00.000Z');
    const start = DateUtil.startOfDayEST('2026-01-01');
    const end = DateUtil.endOfDayEST('2026-08-23');
    const jan1Noon = new Date('2026-01-01T12:00:00.000Z');
    const todayNoon = new Date('2026-08-23T12:00:00.000Z');
    assert.ok(jan1Noon.getTime() >= start.getTime());
    assert.ok(todayNoon.getTime() <= end.getTime());
  });

  it('UTC-midnight start bound includes both midnight and noon dueDates on the first day', () => {
    // Matches HOA invoice list parseDueDateQueryBound inclusive-start semantics.
    const start = new Date(Date.UTC(2026, 7, 1, 0, 0, 0, 0));
    const end = DateUtil.endOfDayEST('2026-08-31');
    const dueMidnight = new Date('2026-08-01T00:00:00.000Z');
    const dueNoon = new Date('2026-08-01T12:00:00.000Z');
    const dueEndNoon = new Date('2026-08-31T12:00:00.000Z');
    assert.ok(dueMidnight.getTime() >= start.getTime());
    assert.ok(dueNoon.getTime() >= start.getTime());
    assert.ok(dueEndNoon.getTime() <= end.getTime());
  });

  it('startOfMonthEST and endOfMonthEST', () => {
    ClockService.setFixedTime('2026-07-15T12:00:00.000Z');
    const start = DateUtil.startOfMonthEST(ClockService.now());
    const end = DateUtil.endOfMonthEST(ClockService.now());
    assert.equal(DateUtil.toEST(start), '2026-07-01');
    assert.equal(DateUtil.toEST(end), '2026-07-31');
  });

  it('addDays and diffDays use calendar days in EST', () => {
    const base = DateUtil.parseDateOnlyToNoonUtc('2026-07-25');
    const next = DateUtil.addDays(base, 1);
    assert.equal(DateUtil.toEST(next), '2026-07-26');
    assert.equal(DateUtil.diffDays(base, next), 1);
  });

  it('isToday respects business timezone', () => {
    ClockService.setFixedTime('2026-07-25T03:30:00.000Z'); // still Jul 24 in ET
    assert.equal(DateUtil.isToday('2026-07-24T12:00:00.000Z'), true);
    assert.equal(DateUtil.isToday('2026-07-25T12:00:00.000Z'), false);
  });

  it('calendarDateTimeInTimezoneToUtc handles DST spring forward', () => {
    // 2026-03-08 02:30 does not exist in ET (springs forward at 2am)
    const instant = DateUtil.calendarDateTimeInTimezoneToUtc('2026-03-08', 3, 0, 0, TIMEZONE.BUSINESS);
    assert.equal(DateUtil.toEST(instant), '2026-03-08');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE.BUSINESS,
      hour: 'numeric',
      hour12: false,
    }).format(instant);
    assert.equal(Number(parts), 3);
  });

  it('calendarDateTimeInTimezoneToUtc handles DST fall back', () => {
    const instant = DateUtil.calendarDateTimeInTimezoneToUtc('2026-11-01', 1, 30, 0, TIMEZONE.BUSINESS);
    assert.equal(DateUtil.toEST(instant), '2026-11-01');
  });

  it('toEpoch and fromEpoch round-trip', () => {
    const ms = DateUtil.toEpoch('2026-07-25T18:42:00.000Z');
    assert.equal(DateUtil.fromEpoch(ms).toISOString(), '2026-07-25T18:42:00.000Z');
  });
});
