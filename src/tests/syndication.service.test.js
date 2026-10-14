/**
 * Unit tests for syndication service helpers.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  listingHasZillowPlatform,
  getSyndicationStatusFromListing,
  resolveProvidersForListing,
} = require('../portals/landlord/modules/listing/service/syndication.service');
const { SYNDICATION_PROVIDERS } = require('../integrations/syndication/syndication.constants');

describe('syndication.service helpers', () => {
  test('listingHasZillowPlatform detects zillow case-insensitively', () => {
    assert.equal(listingHasZillowPlatform({ syndicationPlatforms: ['Zillow'] }), true);
    assert.equal(listingHasZillowPlatform({ syndicationPlatforms: ['apartments'] }), false);
  });

  test('getSyndicationStatusFromListing returns zillow defaults', () => {
    const status = getSyndicationStatusFromListing({
      syndication: {
        zillow: {
          enabled: true,
          published: true,
          lastSyncStatus: 'SUCCESS',
        },
      },
    });
    assert.equal(status.zillow.published, true);
    assert.equal(status.zillow.status, 'SUCCESS');
  });

  test('resolveProvidersForListing filters Zillow when not selected', () => {
    const providers = resolveProvidersForListing(
      { syndicationPlatforms: [] },
      [SYNDICATION_PROVIDERS.ZILLOW]
    );
    assert.equal(providers.length, 0);
  });

  test('resolveProvidersForListing includes Zillow when platform selected', () => {
    const providers = resolveProvidersForListing(
      { syndicationPlatforms: ['zillow'] },
      [SYNDICATION_PROVIDERS.ZILLOW]
    );
    assert.deepEqual(providers, [SYNDICATION_PROVIDERS.ZILLOW]);
  });
});
