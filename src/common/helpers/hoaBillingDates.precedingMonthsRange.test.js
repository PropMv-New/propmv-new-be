const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePrecedingMonthsRange,
  shiftAppYmdMonths,
} = require('./hoaBillingDates');

describe('resolvePrecedingMonthsRange', () => {
  it('shifts months and clamps end-of-month days', () => {
    assert.equal(shiftAppYmdMonths('2026-03-31', -1), '2026-02-28');
    assert.equal(shiftAppYmdMonths('2026-06-01', -3), '2026-03-01');
  });

  it('returns 3 months immediately before last_3_months tenure start', () => {
    // Selected last_3_months starting 2026-06-01 → prior Mar 1 – May 31
    const range = resolvePrecedingMonthsRange('2026-06-01', 3);
    assert.deepEqual(range, { startYmd: '2026-03-01', endYmd: '2026-05-31' });
  });

  it('works for this_month tenure start', () => {
    const range = resolvePrecedingMonthsRange('2026-08-01', 3);
    assert.deepEqual(range, { startYmd: '2026-05-01', endYmd: '2026-07-31' });
  });

  it('works across year boundaries', () => {
    const range = resolvePrecedingMonthsRange('2026-02-01', 3);
    assert.deepEqual(range, { startYmd: '2025-11-01', endYmd: '2026-01-31' });
  });

  it('returns null for invalid start', () => {
    assert.equal(resolvePrecedingMonthsRange(''), null);
    assert.equal(resolvePrecedingMonthsRange('not-a-date'), null);
  });
});
