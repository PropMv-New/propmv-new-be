'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBillingTimezone,
  buildTimezonePropertyFilter,
  DEFAULT_BILLING_TIMEZONE,
} = require('./billingTimezone.constants');

describe('billingTimezone.constants', () => {
  it('resolveBillingTimezone honors a valid property IANA zone', () => {
    assert.equal(resolveBillingTimezone('America/Los_Angeles'), 'America/Los_Angeles');
    assert.equal(resolveBillingTimezone('America/New_York'), 'America/New_York');
  });

  it('resolveBillingTimezone falls back to Eastern for blank or invalid values', () => {
    assert.equal(resolveBillingTimezone(null), DEFAULT_BILLING_TIMEZONE);
    assert.equal(resolveBillingTimezone(''), DEFAULT_BILLING_TIMEZONE);
    assert.equal(resolveBillingTimezone('Not/A_Zone'), DEFAULT_BILLING_TIMEZONE);
  });

  it('buildTimezonePropertyFilter includes unset zones for Eastern default', () => {
    const filter = buildTimezonePropertyFilter('America/New_York');
    assert.ok(Array.isArray(filter.$or));
    assert.ok(filter.$or.some((row) => row.billingTimezone === 'America/New_York'));
  });

  it('buildTimezonePropertyFilter matches Pacific exactly', () => {
    assert.deepEqual(
      buildTimezonePropertyFilter('America/Los_Angeles'),
      { billingTimezone: 'America/Los_Angeles' }
    );
  });
});
