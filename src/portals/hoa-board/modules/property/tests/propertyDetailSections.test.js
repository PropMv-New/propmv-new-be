const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

const propertyServicePath = require.resolve('../service/property.service');

describe('normalizeUnitBillingFieldsForResponse', () => {
  let normalizeUnitBillingFieldsForResponse;

  before(() => {
    ({ normalizeUnitBillingFieldsForResponse } = require(propertyServicePath));
  });

  test('returns null billing fields when billing is not configured', () => {
    const result = normalizeUnitBillingFieldsForResponse({
      startingBalance: 0,
      monthlyRecurringFee: 0,
    });
    assert.deepEqual(result, {
      startingBalance: null,
      balanceAsOf: null,
      monthlyRecurringFee: null,
      paymentTerm: 0,
    });
  });

  test('falls back to createdAt for balanceAsOf when billing is active but date was cleared', () => {
    const createdAt = new Date('2026-08-23T12:00:00.000Z');
    const result = normalizeUnitBillingFieldsForResponse({
      startingBalance: 0,
      monthlyRecurringFee: 100,
      paymentTerm: 12,
      createdAt,
    });
    assert.equal(result.balanceAsOf, createdAt);
    assert.equal(result.monthlyRecurringFee, 100);
    assert.equal(result.paymentTerm, 12);
  });

  test('preserves explicit balanceAsOf when present', () => {
    const balanceAsOf = new Date('2026-08-23T00:00:00.000Z');
    const result = normalizeUnitBillingFieldsForResponse({
      balanceAsOf,
      monthlyRecurringFee: 50,
    });
    assert.equal(result.balanceAsOf, balanceAsOf);
  });
});

describe('parsePropertyDetailInclude', () => {
  let parsePropertyDetailInclude;
  let PROPERTY_DETAIL_SECTIONS;

  before(() => {
    ({ parsePropertyDetailInclude, PROPERTY_DETAIL_SECTIONS } = require(propertyServicePath));
  });

  test('returns all sections when include is omitted', () => {
    const include = parsePropertyDetailInclude(undefined);
    assert.deepEqual([...include].sort(), [...PROPERTY_DETAIL_SECTIONS].sort());
  });

  test('returns all sections when include is all', () => {
    const include = parsePropertyDetailInclude('all');
    assert.deepEqual([...include].sort(), [...PROPERTY_DETAIL_SECTIONS].sort());
  });

  test('returns only requested sections', () => {
    const include = parsePropertyDetailInclude('core,stats,owners');
    assert.deepEqual([...include].sort(), ['core', 'owners', 'stats']);
  });

  test('falls back to all sections for unknown values', () => {
    const include = parsePropertyDetailInclude('unknown-section');
    assert.deepEqual([...include].sort(), [...PROPERTY_DETAIL_SECTIONS].sort());
  });
});
