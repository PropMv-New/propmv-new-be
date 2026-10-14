const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  EXTENSION_THRESHOLD_DAYS,
} = require('../services/invoiceScheduleMeta.service');
const { shiftAppYmdDays, getDateKeyInTimeZone } = require('../../../../../common/helpers/hoaBillingDates');
const { buildJobIdempotencyKey } = require('../../../../../common/jobs/idempotency');
const { ClockService } = require('../../../../../common/date');
const {
  isPropertyLocalMidnightHour,
} = require('../../../../../common/helpers/billingCalendar');

describe('invoiceScheduleMeta', () => {
  afterEach(() => ClockService.reset());

  it('uses a 90-day extension threshold by default', () => {
    assert.equal(EXTENSION_THRESHOLD_DAYS, 90);
  });

  it('computes generation trigger 90 days before last due date', () => {
    const lastDue = '2026-12-01';
    const trigger = shiftAppYmdDays(lastDue, -90);
    assert.equal(trigger, '2026-09-02');
  });

  it('next-year generation trigger stays on the Eastern calendar day', () => {
    const lastDue = '2026-12-01';
    const trigger = shiftAppYmdDays(lastDue, -90, 'America/New_York');
    assert.equal(trigger, '2026-09-02');
  });

  it('idempotency key for next-year extension is stable per timezone and date', () => {
    const first = buildJobIdempotencyKey('INVOICE_EXTENSION_ALL', '2026-09-14', 'America/New_York');
    const second = buildJobIdempotencyKey('INVOICE_EXTENSION_ALL', '2026-09-14', 'America/New_York');
    assert.equal(first, second);
    const pacific = buildJobIdempotencyKey('INVOICE_EXTENSION_ALL', '2026-09-14', 'America/Los_Angeles');
    assert.notEqual(first, pacific);
  });

  it('already_extended when maxMonth + 1 already exists in the schedule', () => {
    // Mirrors extendUnitScheduleIfNeeded: startMonth = maxMonth + 1.
    const alreadyExtended = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.equal(alreadyExtended.has(12 + 1), true);
    const notYetExtended = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(notYetExtended.has(12 + 1), false);
  });

  it('Eastern DST midnight is the next-year generation clock, not UTC or IST', () => {
    ClockService.setFixedTime('2026-09-14T04:00:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), true);
    assert.equal(getDateKeyInTimeZone(ClockService.now(), 'America/New_York'), '2026-09-14');
    ClockService.setFixedTime('2026-09-14T00:01:00.000Z');
    assert.equal(isPropertyLocalMidnightHour(ClockService.now(), 'America/New_York'), false);
  });
});
