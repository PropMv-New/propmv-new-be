/**
 * Unit tests for ZillowSyndicationProvider with mocked dependencies.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ZillowSyndicationProvider = require('../integrations/syndication/zillow/ZillowSyndicationProvider');
const { ZillowValidationError } = require('../integrations/syndication/zillow/zillow.errors');
const Listing = require('../portals/landlord/modules/listing/models/listing.model');
const SyndicationLog = require('../portals/landlord/modules/listing/models/syndicationLog.model');

const dummyListing = {
  _id: '507f1f77bcf86cd799439011',
  propertyType: 'house',
  address: '123 Main St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  rentalAmount: 2500,
  securityDeposit: 2500,
  bedrooms: 2,
  bathrooms: 1,
  description: 'Test listing',
  syndicationPlatforms: ['zillow'],
  updatedAt: new Date(),
};

function createMockProvider(overrides = {}) {
  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  return new ZillowSyndicationProvider({
    logger: mockLogger,
    httpClient: {
      get: async () => ({ data: { listings: [{ status: 'LIVE' }] } }),
    },
    config: {
      companyId: 'TESTCO',
      feedId: 'FEED123',
      contactEmail: 'test@example.com',
      contactPhone: '5125550100',
      realtimeEnabled: false,
      endpoints: { getStatus: 'https://example.com/status' },
      http: { timeoutMs: 5000, maxRetries: 0 },
      ...overrides.config,
    },
    realtimeApiClient: {
      markForUpdate: async (ids) => ({ success: true, queued: ids.length }),
    },
    ...overrides,
  });
}

describe('ZillowSyndicationProvider', () => {
  test('validateListing passes with complete dummy data', async () => {
    const provider = createMockProvider();
    const result = await provider.validateListing(dummyListing);
    assert.equal(result.valid, true);
    assert.equal(result.feedListingId, '507f1f77bcf86cd799439011');
  });

  test('validateListing throws ZillowValidationError when city missing', async () => {
    const provider = createMockProvider();
    await assert.rejects(
      () => provider.validateListing({ ...dummyListing, city: '' }),
      ZillowValidationError
    );
  });

  test('createOrUpdateListing returns success without throwing', async () => {
    const originalUpdate = Listing.updateOne;
    const originalCreate = SyndicationLog.create;
    Listing.updateOne = async () => ({ acknowledged: true });
    SyndicationLog.create = async (doc) => ({ ...doc, _id: 'log1' });

    try {
      const provider = createMockProvider();
      const result = await provider.createOrUpdateListing(dummyListing);
      assert.equal(result.success, true);
      assert.equal(result.providerName, 'ZILLOW');
      assert.match(result.message, /queued/i);
    } finally {
      Listing.updateOne = originalUpdate;
      SyndicationLog.create = originalCreate;
    }
  });

  test('removeListing returns success with empty removal XML hint', async () => {
    const originalUpdate = Listing.updateOne;
    const originalCreate = SyndicationLog.create;
    Listing.updateOne = async () => ({ acknowledged: true });
    SyndicationLog.create = async (doc) => ({ ...doc, _id: 'log1' });

    try {
      const provider = createMockProvider();
      const listing = {
        ...dummyListing,
        syndication: { zillow: { feedListingId: '507f1f77bcf86cd799439011', published: true } },
      };
      const result = await provider.removeListing(listing);
      assert.equal(result.success, true);
      assert.ok(result.removalXml.includes('hotPadsItems'));
    } finally {
      Listing.updateOne = originalUpdate;
      SyndicationLog.create = originalCreate;
    }
  });

  test('getSyncStatus normalizes response', async () => {
    const provider = createMockProvider();
    const result = await provider.getSyncStatus(dummyListing);
    assert.equal(result.success, true);
    assert.equal(result.status, 'LIVE');
  });
});
