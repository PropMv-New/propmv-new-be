'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClockService } = require('../date');
const {
  getCalendarDaysLateInTimezone,
  getGracePeriodEndYmd,
  getFirstLateFeeEligibleYmd,
  isPropertyLocalMidnightHour,
  getBillingTimezonesAtLocalHour,
} = require('./billingCalendar');

describe('billingCalendar', () => {
  afterEach(() => ClockService.reset());

  it('getCalendarDaysLateInTimezone counts whole days in property TZ', () => {
    ClockService.setFixedTime('2026-07-05T16:00:00.000Z');
    const daysLate = getCalendarDaysLateInTimezone(
      '2026-07-01',
      ClockService.now(),
      'America/New_York'
    );
    assert.equal(daysLate, 4);
  });

  it('getGracePeriodEndYmd and first eligible day follow grace period', () => {
    const graceEnd = getGracePeriodEndYmd('2026-07-01', 3, 'America/New_York');
    const firstEligible = getFirstLateFeeEligibleYmd('2026-07-01', 3, 'America/New_York');
    assert.equal(graceEnd, '2026-07-04');
    assert.equal(firstEligible, '2026-07-05');
    assert.ok(firstEligible > graceEnd);
  });

  it('isPropertyLocalMidnightHour detects local hour 0', () => {
    // 2026-07-05 04:00 UTC = 2026-07-05 00:00 ET (EDT)
    ClockService.setFixedTime('2026-07-05T04:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), true);
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/Los_Angeles'), false);
  });

  it('getBillingTimezonesAtLocalHour returns zones at midnight', () => {
    ClockService.setFixedTime('2026-07-05T04:00:00.000Z');
    const zones = getBillingTimezonesAtLocalHour(0, ClockService.now());
    assert.ok(zones.includes('America/New_York'));
    assert.ok(!zones.includes('America/Los_Angeles'));
  });

  it('EDT midnight is 04:00 UTC on Sep 14, 2026', () => {
    ClockService.setFixedTime('2026-09-14T04:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), true);
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/Los_Angeles'), false);
    const zones = getBillingTimezonesAtLocalHour(0, ClockService.now());
    assert.ok(zones.includes('America/New_York'));
  });

  it('EST midnight is 05:00 UTC on Jan 14, 2026', () => {
    ClockService.setFixedTime('2026-01-14T05:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), true);
    const zones = getBillingTimezonesAtLocalHour(0, ClockService.now());
    assert.ok(zones.includes('America/New_York'));
  });

  it('UTC midnight is still the previous evening in Eastern - not the business trigger', () => {
    ClockService.setFixedTime('2026-09-14T00:01:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), false);
    const { getDateKeyInTimeZone } = require('./hoaBillingDates');
    assert.equal(getDateKeyInTimeZone(ClockService.now(), 'America/New_York'), '2026-09-13');
  });

  it('Asia/Kolkata offset does not change America/New_York midnight', () => {
    ClockService.setFixedTime('2026-09-14T04:00:00.000Z');
    const { getDateKeyInTimeZone } = require('./hoaBillingDates');
    assert.equal(getDateKeyInTimeZone(ClockService.now(), 'America/New_York'), '2026-09-14');
    assert.equal(getDateKeyInTimeZone(ClockService.now(), 'Asia/Kolkata'), '2026-09-14');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), true);
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'Asia/Kolkata'), false);
  });

  it('spring-forward 2026 keeps Eastern midnight at 05:00 UTC (still EST)', () => {
    // DST starts Mar 8, 2026 at 2:00 AM EST. Midnight is still UTC-5.
    ClockService.setFixedTime('2026-03-08T05:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), true);
    ClockService.setFixedTime('2026-03-08T04:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), false);
  });

  it('fall-back 2026 keeps Eastern midnight at 04:00 UTC (still EDT)', () => {
    // DST ends Nov 1, 2026 at 2:00 AM EDT. Midnight is still UTC-4.
    ClockService.setFixedTime('2026-11-01T04:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), true);
    ClockService.setFixedTime('2026-11-01T05:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), false);
  });

  it('Pacific midnight is 07:00 UTC in September and does not fire Eastern', () => {
    ClockService.setFixedTime('2026-09-14T07:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/Los_Angeles'), true);
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), false);
    const zones = getBillingTimezonesAtLocalHour(0, ClockService.now());
    assert.ok(zones.includes('America/Los_Angeles'));
    assert.ok(!zones.includes('America/New_York'));
  });
});
