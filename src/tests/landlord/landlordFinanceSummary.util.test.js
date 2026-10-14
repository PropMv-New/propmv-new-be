const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLandlordInvoiceDueDateFilter,
  buildLandlordInvoiceBaseFilter,
  EMPTY_FINANCE_SUMMARY,
} = require('../../shared/utils/landlordFinanceSummary.util');
const { OBJECT_ID, OBJECT_ID_2 } = require('./helpers/fixtures');

describe('buildLandlordInvoiceDueDateFilter', () => {
  test('returns empty object when start or end date is missing', () => {
    assert.deepEqual(buildLandlordInvoiceDueDateFilter('2026-01-01', null), {});
    assert.deepEqual(buildLandlordInvoiceDueDateFilter(null, '2026-01-31'), {});
  });

  test('builds dueDate range from YMD strings', () => {
    const filter = buildLandlordInvoiceDueDateFilter('2026-01-01', '2026-01-31');
    assert.ok(filter.dueDate);
    assert.ok(filter.dueDate.$gte instanceof Date);
    assert.ok(filter.dueDate.$lte instanceof Date);
    assert.equal(filter.dueDate.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(filter.dueDate.$lte.toISOString(), '2026-01-31T00:00:00.000Z');
  });

  test('returns empty object for invalid date strings', () => {
    assert.deepEqual(
      buildLandlordInvoiceDueDateFilter('not-a-date', 'also-bad'),
      {},
    );
  });
});

describe('buildLandlordInvoiceBaseFilter', () => {
  test('returns null when propertyIds is empty', () => {
    assert.equal(buildLandlordInvoiceBaseFilter([]), null);
    assert.equal(buildLandlordInvoiceBaseFilter(null), null);
  });

  test('scopes invoices to property ids and excludes deleted', () => {
    const filter = buildLandlordInvoiceBaseFilter([OBJECT_ID, OBJECT_ID_2]);
    assert.deepEqual(filter.propertyId.$in, [OBJECT_ID, OBJECT_ID_2]);
    assert.deepEqual(filter.isDeleted, { $ne: true });
  });

  test('merges due date filter when provided', () => {
    const filter = buildLandlordInvoiceBaseFilter(
      [OBJECT_ID],
      { startDate: '2026-03-01', endDate: '2026-03-31' },
    );
    assert.ok(filter.dueDate);
  });
});

describe('EMPTY_FINANCE_SUMMARY', () => {
  test('has zeroed financial buckets', () => {
    assert.deepEqual(EMPTY_FINANCE_SUMMARY, {
      collectedAmount: 0,
      processingAmount: 0,
      overdueAmount: 0,
      comingDueAmount: 0,
      totalAmount: 0,
      outstandingAmount: 0,
      collectionRate: 0,
    });
  });
});
