/**
 * ------------------------------------------------------------------
 * File: syndication.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * syndication.controller, listing.service
 * ------------------------------------------------------------------
 */

const SyndicationProviderFactory = require('../../../../../integrations/syndication/SyndicationProviderFactory');
const { SYNDICATION_PROVIDERS } = require('../../../../../integrations/syndication/syndication.constants');
const logger = require('../../../../../common/logger');
const Listing = require('../models/listing.model');
const { LISTING_STATUS } = require('../../../../../common/constants/listing');
const zillowConfig = require('../../../../../integrations/syndication/zillow/zillow.config');
const {
  enrichListingUnitFieldsFromProperty,
  LISTING_PROPERTY_UNIT_SELECT,
} = require('../helpers/listingUnitFields.helper');

const ACTIVE_LISTING_STATUSES = [LISTING_STATUS.ACTIVE, LISTING_STATUS.PUBLISHED, LISTING_STATUS.PUBLISH_IN_PROGRESS];
const ZILLOW_PLATFORM_NAMES = [zillowConfig.platformId, 'Zillow', 'ZILLOW'];

/**
 * listing Has Zillow Platform
 *
 * Performs logic operations for listingHasZillowPlatform.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function listingHasZillowPlatform(listing) {
  const platforms = listing.syndicationPlatforms || [];
  return platforms.some((p) => ZILLOW_PLATFORM_NAMES.includes(String(p))
    || String(p).toLowerCase() === 'zillow');
}

/**
 * resolve Providers For Listing
 *
 * Performs logic operations for resolveProvidersForListing.
 *
 * @param listing - Request/input argument
 * @param requestedProviders - Request/input argument
 * @returns Operations result
 */
function resolveProvidersForListing(listing, requestedProviders) {
  if (!zillowConfig.enabled) {
    return [];
  }

  const providers = requestedProviders && requestedProviders.length
    ? requestedProviders
    : [SYNDICATION_PROVIDERS.ZILLOW];

  return providers.filter((provider) => {
    if (provider === SYNDICATION_PROVIDERS.ZILLOW) {
      return listingHasZillowPlatform(listing) || listing.syndication?.zillow?.enabled;
    }
    return true;
  });
}

/**
 * is Published Listing
 *
 * Performs logic operations for isPublishedListing.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function isPublishedListing(listing) {
  return ACTIVE_LISTING_STATUSES.includes(listing.status);
}

/**
 * Orchestration layer for listing syndication.
 * Controllers/services call this module - never SyndicationProviderFactory directly.
 */
async function runProviderAction(listing, providers, actionName) {
  const results = [];

  for (const providerName of providers) {
    try {
      const provider = SyndicationProviderFactory.getProvider(providerName);
      const result = await provider[actionName](listing);
      results.push(result);
    } catch (error) {
      logger.error('Syndication provider action failed', {
        listingId: listing._id,
        provider: providerName,
        action: actionName,
        error: error.message,
      });
      results.push({
        success: false,
        providerName,
        listingId: String(listing._id),
        message: error.message,
      });
    }
  }

  return results;
}

/**
 * Fire-and-forget wrapper - never blocks or crashes the main listing flow.
 */
function runAsyncSyndication(fn, context) {
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      logger.error('Async syndication task failed', {
        ...context,
        error: error.message,
        stack: error.stack,
      });
    });
}

async function hydrateListingForSyndication(listingId) {
  const listing = await Listing.findOne({ _id: listingId, isDeleted: { $ne: true } })
    .populate({
      path: 'propertyId',
      select: LISTING_PROPERTY_UNIT_SELECT,
      match: { isDeleted: { $ne: true } },
    })
    .populate({
      path: 'images.documentMetaDataId',
      select: 's3Location key',
    })
    .lean();

  return enrichListingUnitFieldsFromProperty(listing);
}

async function syncListing(listingOrId, providers = [SYNDICATION_PROVIDERS.ZILLOW]) {
  const listing = typeof listingOrId === 'object' && listingOrId._id
    ? listingOrId
    : await hydrateListingForSyndication(listingOrId);

  if (!listing) {
    return { success: false, message: 'Listing not found' };
  }

  const enabledProviders = resolveProvidersForListing(listing, providers);
  if (!enabledProviders.length) {
    return { success: true, skipped: true, message: 'No syndication providers enabled for listing' };
  }

  const results = await runProviderAction(listing, enabledProviders, 'createOrUpdateListing');
  return { success: results.every((r) => r.success), results };
}

async function publishListing(listingOrId, providers = [SYNDICATION_PROVIDERS.ZILLOW]) {
  const listing = typeof listingOrId === 'object' && listingOrId._id
    ? listingOrId
    : await hydrateListingForSyndication(listingOrId);

  if (!listing) return { success: false, message: 'Listing not found' };

  await Listing.updateOne(
    { _id: listing._id },
    {
      $set: {
        'syndication.zillow.enabled': listingHasZillowPlatform(listing),
      },
    }
  );

  const enabledProviders = resolveProvidersForListing(listing, providers);
  if (!enabledProviders.length) {
    return { success: true, skipped: true, message: 'Zillow not selected for this listing' };
  }

  const results = await runProviderAction(listing, enabledProviders, 'createOrUpdateListing');
  return { success: results.every((r) => r.success), results };
}

async function unpublishListing(listingOrId, providers = [SYNDICATION_PROVIDERS.ZILLOW]) {
  const listing = typeof listingOrId === 'object' && listingOrId._id
    ? listingOrId
    : await hydrateListingForSyndication(listingOrId);

  if (!listing) return { success: false, message: 'Listing not found' };

  const enabledProviders = providers.filter((p) =>
    p === SYNDICATION_PROVIDERS.ZILLOW
      ? (listing.syndication?.zillow?.published || listingHasZillowPlatform(listing))
      : true
  );

  if (!enabledProviders.length) {
    return { success: true, skipped: true };
  }

  const results = await runProviderAction(listing, enabledProviders, 'removeListing');
  return { success: results.every((r) => r.success), results };
}

/**
 * sync Listing Async
 *
 * Performs logic operations for syncListingAsync.
 *
 * @param listing - Request/input argument
 * @param providers - Request/input argument
 * @returns Operations result
 */
function syncListingAsync(listing, providers) {
  if (!listing || !isPublishedListing(listing)) return;
  if (!resolveProvidersForListing(listing, providers).length) return;

  runAsyncSyndication(
    () => syncListing(listing, providers),
    { listingId: listing._id, action: 'syncListing' }
  );
}

/**
 * publish Listing Async
 *
 * Performs logic operations for publishListingAsync.
 *
 * @param listing - Request/input argument
 * @param providers - Request/input argument
 * @returns Operations result
 */
function publishListingAsync(listing, providers) {
  if (!listing) return;
  runAsyncSyndication(
    () => publishListing(listing, providers),
    { listingId: listing._id, action: 'publishListing' }
  );
}

/**
 * unpublish Listing Async
 *
 * Performs logic operations for unpublishListingAsync.
 *
 * @param listing - Request/input argument
 * @param providers - Request/input argument
 * @returns Operations result
 */
function unpublishListingAsync(listing, providers) {
  if (!listing) return;
  runAsyncSyndication(
    () => unpublishListing(listing, providers),
    { listingId: listing._id, action: 'unpublishListing' }
  );
}

/**
 * get Syndication Status From Listing
 *
 * Performs logic operations for getSyndicationStatusFromListing.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function getSyndicationStatusFromListing(listing) {
  if (!listing) return {};
  return {
    zillow: listing.syndication?.zillow
      ? {
          enabled: listing.syndication.zillow.enabled,
          published: listing.syndication.zillow.published,
          feedListingId: listing.syndication.zillow.feedListingId,
          lastSyncedAt: listing.syndication.zillow.lastSyncedAt,
          status: listing.syndication.zillow.lastSyncStatus,
          lastSyncError: listing.syndication.zillow.lastSyncError,
          publishedAt: listing.syndication.zillow.publishedAt,
          unpublishedAt: listing.syndication.zillow.unpublishedAt,
        }
      : { enabled: false, published: false },
  };
}

async function getLiveSyndicationStatus(listingId, providers = [SYNDICATION_PROVIDERS.ZILLOW]) {
  const listing = await hydrateListingForSyndication(listingId);
  if (!listing) return null;

  const cached = getSyndicationStatusFromListing(listing);
  const live = {};

  for (const providerName of providers) {
    const provider = SyndicationProviderFactory.getProvider(providerName);
    live[providerName.toLowerCase()] = await provider.getSyncStatus(listing);
  }

  return { cached, live };
}

module.exports = {
  syncListing,
  publishListing,
  unpublishListing,
  syncListingAsync,
  publishListingAsync,
  unpublishListingAsync,
  getSyndicationStatusFromListing,
  getLiveSyndicationStatus,
  listingHasZillowPlatform,
  resolveProvidersForListing,
};
