const test = require('node:test');
const assert = require('node:assert/strict');
const { DateUtil } = require('../date');
const {
  formatDateInAppTimezone,
  formatEmailDate,
  formatEmailDateTime,
} = require('./hoaBillingDates');

test('formatESTDate renders date-only without time', () => {
  const value = new Date('2027-07-01T12:00:00.000Z');
  assert.equal(DateUtil.formatESTDate(value), 'Jul 01, 2027');
});

test('formatEmailDate matches date-only app timezone formatting', () => {
  const value = new Date('2027-07-01T12:00:00.000Z');
  assert.equal(formatEmailDate(value), 'Jul 01, 2027');
  assert.equal(formatDateInAppTimezone(value), 'Jul 01, 2027');
});

test('formatEmailDateTime renders user-friendly datetime', () => {
  const value = new Date('2027-07-01T12:30:00.000Z');
  assert.equal(formatEmailDateTime(value), 'Jul 01, 2027, 08:30 AM');
});
