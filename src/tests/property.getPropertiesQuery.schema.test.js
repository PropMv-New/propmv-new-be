/**
 * Unit tests: GET /property/properties query validation (no database).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { getPropertiesQuerySchema } = require('../portals/landlord/modules/property/validators/property.validator');

const CREATED_BY = '697db8cacdd6418e078aa166';

describe('getPropertiesQuerySchema', () => {
  test('accepts search with pagination and createdBy', () => {
    const { error, value } = getPropertiesQuerySchema.validate({
      pageNumber: 1,
      pagesize: 5,
      search: 'hgh',
      createdBy: CREATED_BY,
    });

    assert.equal(error, undefined);
    assert.equal(value.search, 'hgh');
    assert.equal(value.createdBy, CREATED_BY);
  });

  test('accepts filter params used by getPropertiesService', () => {
    const { error, value } = getPropertiesQuerySchema.validate({
      pageNumber: 1,
      pageSize: 10,
      status: 'vacant',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      numberOfUnits: 2,
      hasOpenMaintenance: true,
      isArchived: false,
      rentStatus: 'overdue',
      maintenance: 'open',
      lease: 'expiring',
      search: 'Oak',
      sortBy: 'name',
      order: 'asc',
      createdBy: CREATED_BY,
    });

    assert.equal(error, undefined);
    assert.equal(value.search, 'Oak');
    assert.equal(value.rentStatus, 'overdue');
    assert.equal(value.maintenance, 'open');
    assert.equal(value.lease, 'expiring');
  });

  test('rejects invalid createdBy', () => {
    const { error } = getPropertiesQuerySchema.validate({
      createdBy: 'not-an-object-id',
    });

    assert.ok(error, 'expected validation error for invalid createdBy');
    assert.ok(
      error.details.some((detail) => detail.path.join('.') === 'createdBy'),
      'expected createdBy field error',
    );
  });

  test('allows unknown query params', () => {
    const { error } = getPropertiesQuerySchema.validate({
      pageNumber: 1,
      unknownParam: 'x',
    });

    assert.equal(error, undefined, 'unknown params should be allowed');
  });
});
