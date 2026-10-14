const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { summaryQuerySchema } = require('../../../portals/landlord/modules/dashboard/validators/dashboard.validator');
const { CREATED_BY } = require('../helpers/fixtures');

describe('dashboard summaryQuerySchema', () => {
  test('accepts valid date range and createdBy', () => {
    const { error, value } = summaryQuerySchema.validate({
      createdBy: CREATED_BY,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    assert.equal(error, undefined);
    assert.equal(value.createdBy, CREATED_BY);
  });

  test('accepts ISO date strings', () => {
    const { error } = summaryQuerySchema.validate({
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-31T23:59:59.999Z',
    });
    assert.equal(error, undefined);
  });

  test('accepts empty query', () => {
    const { error } = summaryQuerySchema.validate({});
    assert.equal(error, undefined);
  });

  test('rejects invalid createdBy', () => {
    const { error } = summaryQuerySchema.validate({ createdBy: 'bad-id' });
    assert.ok(error);
  });

  test('rejects malformed date strings', () => {
    const { error } = summaryQuerySchema.validate({
      startDate: '01/01/2026',
    });
    assert.ok(error);
  });
});
