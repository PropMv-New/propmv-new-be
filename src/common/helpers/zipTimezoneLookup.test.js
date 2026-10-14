'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  lookupTimezoneFromZip,
  lookupTimezoneFromAddress,
  lookupTimezoneOrDefault,
  normalizeZip,
} = require('./zipTimezoneLookup');

describe('zipTimezoneLookup', () => {
  it('normalizeZip strips non-digits and requires 5 digits', () => {
    assert.equal(normalizeZip('12345-6789'), '12345');
    assert.equal(normalizeZip('12'), null);
    assert.equal(normalizeZip(''), null);
  });

  it('lookupTimezoneFromZip uses zip3 override for Phoenix', () => {
    assert.equal(lookupTimezoneFromZip('85001', 'AZ'), 'America/Phoenix');
  });

  it('lookupTimezoneFromZip falls back to state default', () => {
    assert.equal(lookupTimezoneFromZip('02108', 'MA'), 'America/New_York');
    assert.equal(lookupTimezoneFromZip('60601', 'IL'), 'America/Chicago');
    assert.equal(lookupTimezoneFromZip('90210', 'CA'), 'America/Los_Angeles');
  });

  it('lookupTimezoneFromAddress reads address.zip', () => {
    assert.equal(
      lookupTimezoneFromAddress({ zip: '99501', state: 'AK' }),
      'America/Anchorage'
    );
  });

  it('lookupTimezoneFromAddress reads address.zipCode', () => {
    assert.equal(
      lookupTimezoneFromAddress({ zipCode: '90210', state: 'CA' }),
      'America/Los_Angeles'
    );
  });

  it('lookupTimezoneOrDefault returns Eastern when lookup fails', () => {
    assert.equal(lookupTimezoneOrDefault('', ''), 'America/New_York');
  });
});
