'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  billingCalendarDateKey,
  getDateKeyInTimeZone,
  compareCalendarDateToToday,
  formatDateInAppTimezone,
  formatMonthYearInAppTimezone,
} = require('./hoaBillingDates');

describe('billingCalendarDateKey', () => {
  it('keeps UTC midnight calendar day (does not ET-shift Aug 10 → Aug 9)', () => {
    const midnight = new Date('2026-08-10T00:00:00.000Z');
    assert.equal(billingCalendarDateKey(midnight), '2026-08-10');
    assert.equal(getDateKeyInTimeZone(midnight), '2026-08-09');
  });

  it('keeps UTC noon calendar day', () => {
    const noon = new Date('2026-08-10T12:00:00.000Z');
    assert.equal(billingCalendarDateKey(noon), '2026-08-10');
  });

  it('compareCalendarDateToToday treats midnight Aug 10 as Aug 10', () => {
    const due = new Date('2026-08-10T00:00:00.000Z');
    const ref = new Date('2026-08-10T16:00:00.000Z'); // afternoon ET
    assert.equal(compareCalendarDateToToday(due, ref), 0);
  });

  it('formatDateInAppTimezone shows Aug 10 for UTC midnight Aug 10', () => {
    const formatted = formatDateInAppTimezone(new Date('2026-08-10T00:00:00.000Z'), {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    assert.match(formatted, /August\s+10,\s+2026/i);
  });

  it('formatMonthYearInAppTimezone uses Jan for Jan 1 UTC midnight (not prior Dec)', () => {
    const formatted = formatMonthYearInAppTimezone(new Date('2026-01-01T00:00:00.000Z'), {
      longMonth: true,
    });
    assert.match(formatted, /January\s+2026/i);
  });
});
