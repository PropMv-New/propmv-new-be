const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Invoice = require('../../invoice/model/invoice.model');
const { syncAssociatedInvoiceLabels } = require('../services/unit.service');

describe('syncAssociatedInvoiceLabels', () => {
  let originalUpdateMany;

  beforeEach(() => {
    originalUpdateMany = Invoice.updateMany;
  });

  afterEach(() => {
    Invoice.updateMany = originalUpdateMany;
  });

  it('rewrites associated invoice unit labels when the unit number changes', async () => {
    const calls = [];
    Invoice.updateMany = async (filter, update, options) => {
      calls.push({ filter, update, options });
      return { modifiedCount: 2 };
    };

    await syncAssociatedInvoiceLabels('507f1f77bcf86cd799439011', {
      unitLabel: '202',
      previousUnitLabel: '101',
      propertyName: 'Sunset HOA',
      previousPropertyName: 'Sunset HOA',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].update.$set.unit, '202');
    assert.equal(calls[0].update.$set.propertyName, undefined);
  });

  it('does not write invoice labels when the unit number is unchanged', async () => {
    let called = false;
    Invoice.updateMany = async () => {
      called = true;
      return { modifiedCount: 0 };
    };

    const result = await syncAssociatedInvoiceLabels('507f1f77bcf86cd799439011', {
      unitLabel: '101',
      previousUnitLabel: '101',
      propertyName: 'Sunset HOA',
      previousPropertyName: 'Sunset HOA',
    });

    assert.equal(called, false);
    assert.equal(result.modifiedCount, 0);
  });

  it('keeps the invoice associated to the same propertyId while updating labels', async () => {
    const calls = [];
    Invoice.updateMany = async (filter, update) => {
      calls.push({ filter, update });
      return { modifiedCount: 1 };
    };

    await syncAssociatedInvoiceLabels('507f1f77bcf86cd799439011', {
      unitLabel: 'B2',
      previousUnitLabel: 'A1',
      propertyName: 'New Community',
      previousPropertyName: 'Old Community',
    });

    assert.equal(String(calls[0].filter.propertyId), '507f1f77bcf86cd799439011');
    assert.equal(calls[0].update.$set.unit, 'B2');
    assert.equal(calls[0].update.$set.propertyName, 'New Community');
  });
});
