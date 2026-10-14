/**
 * Unit tests: HOA owner invoice property scope (historical retention after unit deletion).
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const Invoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const { resolveHoaOwnerInvoicePropertyIds } = require('./hoaPropertyScope');

describe('resolveHoaOwnerInvoicePropertyIds', () => {
  let originalPropertyFind;
  let originalInvoiceDistinct;

  beforeEach(() => {
    originalPropertyFind = Property.find;
    originalInvoiceDistinct = Invoice.distinct;
  });

  afterEach(() => {
    Property.find = originalPropertyFind;
    Invoice.distinct = originalInvoiceDistinct;
  });

  test('unions active units with deleted units that have preserved invoices', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const activeId = new mongoose.Types.ObjectId();
    const deletedId = new mongoose.Types.ObjectId();

    Property.find = function mockFind() {
      return {
        select() { return this; },
        lean() {
          return Promise.resolve([{ _id: activeId }]);
        },
      };
    };

    Invoice.distinct = function mockDistinct(_field, filter) {
      assert.equal(String(filter.tenants), String(ownerId));
      assert.equal(filter.isDeleted.$ne, true);
      return Promise.resolve([deletedId]);
    };

    const scopeIds = await resolveHoaOwnerInvoicePropertyIds(ownerId);
    const scopeStrings = scopeIds.map(String);

    assert.ok(scopeStrings.includes(String(activeId)));
    assert.ok(scopeStrings.includes(String(deletedId)));
    assert.equal(scopeStrings.length, 2);
  });

  test('intersects with requested property ids', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const deletedId = new mongoose.Types.ObjectId();
    const unrelatedId = new mongoose.Types.ObjectId();

    Property.find = function mockFind() {
      return {
        select() { return this; },
        lean() { return Promise.resolve([]); },
      };
    };

    Invoice.distinct = function mockDistinct() {
      return Promise.resolve([deletedId]);
    };

    const scopeIds = await resolveHoaOwnerInvoicePropertyIds(ownerId, [deletedId, unrelatedId]);
    assert.deepEqual(scopeIds.map(String), [String(deletedId)]);
  });
});
