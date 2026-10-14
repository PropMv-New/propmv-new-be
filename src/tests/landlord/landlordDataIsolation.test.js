const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { applyLandlordDataFilter } = require('../../middleware/landlordDataIsolation');
const { CREATED_BY } = require('./helpers/fixtures');

describe('applyLandlordDataFilter', () => {
  test('returns query unchanged when context is missing', () => {
    const query = { status: 'active' };
    assert.deepEqual(applyLandlordDataFilter(query, null), query);
  });

  test('returns query unchanged when user is not a landlord', () => {
    const query = { status: 'active' };
    const result = applyLandlordDataFilter(query, { userId: CREATED_BY, isLandlord: false });
    assert.deepEqual(result, query);
  });

  test('wraps existing query with landlord owner filter', () => {
    const query = { status: 'active' };
    const result = applyLandlordDataFilter(query, { userId: CREATED_BY, isLandlord: true });
    assert.ok(result.$and);
    assert.equal(result.$and.length, 2);
    assert.deepEqual(result.$and[0], { status: 'active' });
    assert.ok(result.$and[1].$or);
  });

  test('appends landlord filter to existing $and array', () => {
    const query = { $and: [{ status: 'active' }] };
    const result = applyLandlordDataFilter(query, { userId: CREATED_BY, isLandlord: true });
    assert.equal(result.$and.length, 2);
  });

  test('applies landlord filter to empty query', () => {
    const result = applyLandlordDataFilter({}, { userId: CREATED_BY, isLandlord: true });
    assert.ok(result.$or);
  });
});
