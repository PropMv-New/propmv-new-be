/**
 * Unit tests: listing service transaction helpers.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const listingService = require('../portals/landlord/modules/listing/service/listing.service');

const {
  withListingTransaction,
  runInTransaction,
} = listingService;

describe('withListingTransaction', () => {
  test('reuses caller session without starting a nested transaction', async () => {
    const fakeSession = { id: 'listing-session' };
    let receivedSession = null;

    const result = await withListingTransaction(async (session) => {
      receivedSession = session;
      return 'ok';
    }, { session: fakeSession });

    assert.equal(result, 'ok');
    assert.equal(receivedSession, fakeSession);
  });

  test('runInTransaction is exported for service-layer use', () => {
    assert.equal(typeof runInTransaction, 'function');
  });
});

describe('listing service exports', () => {
  test('keeps backward-compatible service aliases', () => {
    assert.equal(listingService.createListing, listingService.createListingService);
    assert.equal(listingService.updateListing, listingService.updateListingService);
    assert.equal(listingService.setInactiveListing, listingService.setInactiveListingService);
  });
});
