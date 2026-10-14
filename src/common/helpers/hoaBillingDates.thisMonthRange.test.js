const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClockService } = require('../date');
const { isThisMonthDateRangeKeys } = require('./hoaBillingDates');

describe('isThisMonthDateRangeKeys', () => {
  afterEach(() => ClockService.reset());

  it('matches canonical this_month YMD bounds', () => {
    ClockService.setFixedTime('2026-08-29T17:00:00.000Z');
    assert.equal(isThisMonthDateRangeKeys('2026-08-01', '2026-08-31'), true);
  });

  it('rejects last month bounds', () => {
    ClockService.setFixedTime('2026-08-29T17:00:00.000Z');
    assert.equal(isThisMonthDateRangeKeys('2026-07-01', '2026-07-31'), false);
  });
});
