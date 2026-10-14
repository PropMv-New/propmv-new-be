/**
 * Unit tests: invoice service transaction helpers.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { withInvoiceTransaction } = require('../portals/landlord/modules/invoice/service/invoice.service');
const { runInTransaction } = require('../common/helpers/transactionHelper');

const { mergeInvoiceScopeFromActor } = require('../portals/landlord/modules/invoice/service/invoice.service');

describe('withInvoiceTransaction', () => {
  test('reuses caller session without starting a nested transaction', async () => {
    const fakeSession = { id: 'invoice-session' };
    let receivedSession = null;
    const result = await withInvoiceTransaction(async (session) => {
      receivedSession = session;
      return 'ok';
    }, { session: fakeSession });
    assert.equal(result, 'ok');
    assert.equal(receivedSession, fakeSession);
  });

  test('runInTransaction is exported', () => {
    assert.equal(typeof runInTransaction, 'function');
  });
});

describe('mergeInvoiceScopeFromActor', () => {
  test('merges createdBy from actor when missing on payload', () => {
    const actorId = '507f1f77bcf86cd799439011';
    const merged = mergeInvoiceScopeFromActor({}, actorId);
    assert.equal(String(merged.createdBy), actorId);
  });
});
