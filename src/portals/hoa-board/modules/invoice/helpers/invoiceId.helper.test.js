const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Invoice = require('../model/invoice.model');
const {
  makeInvoiceId,
  isShortInvoiceId,
  allocateUniqueInvoiceIds,
} = require('./invoiceId.helper');

describe('allocateUniqueInvoiceIds', () => {
  let originalFind;

  beforeEach(() => {
    originalFind = Invoice.find;
  });

  afterEach(() => {
    Invoice.find = originalFind;
  });

  it('returns the requested count of unique short IDs when none collide', async () => {
    Invoice.find = function mockFind() {
      return {
        select() { return this; },
        lean() { return Promise.resolve([]); },
        session() { return this; },
      };
    };

    const ids = await allocateUniqueInvoiceIds(60);
    assert.equal(ids.length, 60);
    assert.equal(new Set(ids).size, 60);
    ids.forEach((id) => assert.ok(isShortInvoiceId(id)));
  });

  it('retries candidates that already exist in the database', async () => {
    const existingId = makeInvoiceId();
    let call = 0;
    Invoice.find = function mockFind(filter) {
      return {
        select() { return this; },
        session() { return this; },
        lean() {
          call += 1;
          if (call === 1 && filter.invoiceId.$in.includes(existingId)) {
            return Promise.resolve([{ invoiceId: existingId }]);
          }
          return Promise.resolve([]);
        },
      };
    };

    const ids = await allocateUniqueInvoiceIds(3);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.ok(!ids.includes(existingId));
  });
});
