/**
 * ------------------------------------------------------------------
 * File: ZillowSyndicationProvider.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for ZillowSyndicationProvider.
 *
 * Used By:
 * SyndicationProviderFactory
 * ------------------------------------------------------------------
 */

const ListingSyndicationProvider = require('../ListingSyndicationProvider');
const { SYNDICATION_PROVIDERS } = require('../syndication.constants');
const { ZillowValidationError } = require('./zillow.errors');
const ZillowRealtimeApiClient = require('./zillowRealtimeApiClient');
const ZillowFeedFileService = require('./zillowFeedFileService');
const { ClockService, DateUtil } = require('../../../common/date');
const {
  buildHotPadsFeedXml,
  buildEmptyFeedXml,
  normalizeListingForZillow,
  toFeedListingId,
} = require('./zillowXmlBuilder');
const { parseGetStatusResponse } = require('./zillowResponseParser');
const Listing = require('../../../portals/landlord/modules/listing/models/listing.model');
const SyndicationLog = require('../../../portals/landlord/modules/listing/models/syndicationLog.model');
const { SYNDICATION_ACTIONS, SYNDICATION_SYNC_STATUS } = require('../syndication.constants');

/**
 * Zillow Rentals syndication provider.
 * Orchestrates validation, XML mapping, real-time API, and bulk feed inclusion.
 */
class ZillowSyndicationProvider extends ListingSyndicationProvider {
  constructor(deps = {}) {
    super(deps);
    this.realtimeApiClient = deps.realtimeApiClient
      || new ZillowRealtimeApiClient({ httpClient: this.httpClient, config: this.config, logger: this.logger });
    this.feedFileService = deps.feedFileService
      || new ZillowFeedFileService({ config: this.config, logger: this.logger });
  }

  getProviderName() {
    return SYNDICATION_PROVIDERS.ZILLOW;
  }

  /**
   * Validates Zillow-required fields before sync attempt.
   */
  async validateListing(listing) {
    const normalized = normalizeListingForZillow(listing, this.config);
    const errors = [];

    const required = [
      ['address/street', resolveStreet(normalized)],
      ['city', normalized.city],
      ['state', normalized.state],
      ['zip', normalized.zip],
      ['contactEmail', normalized.contactEmail || this.config.contactEmail],
      ['contactPhone', normalized.contactPhone || this.config.contactPhone],
      ['rentalAmount/price', normalized.rentalAmount],
      ['numBedrooms', normalized.bedrooms],
      ['numFullBaths', normalized.bathrooms],
    ];

    required.forEach(([field, value]) => {
      if (value == null || value === '') {
        errors.push(`${field} is required for Zillow syndication`);
      }
    });

    if (!this.config.companyId) errors.push('ZILLOW_COMPANY_ID is not configured');
    if (!this.config.feedId) errors.push('ZILLOW_FEED_ID is not configured');

    const feedId = toFeedListingId(normalized);
    if (feedId.includes('_')) {
      this.logger.warn('Zillow feed listing ID contains underscore (will be stripped by Zillow)', {
        listingId: listing._id,
        provider: 'ZILLOW',
        action: 'validate',
        feedListingId: feedId,
      });
    }

    if (errors.length) {
      throw new ZillowValidationError('Listing failed Zillow validation', errors);
    }

    return { valid: true, feedListingId: feedId };
  }

  async mapListingToProviderFormat(listing) {
    const normalized = normalizeListingForZillow(listing, this.config);
    await this.validateListing(normalized);
    return buildHotPadsFeedXml([normalized], this.config);
  }

  async logSyndicationAttempt({
    listingId,
    action,
    success,
    durationMs,
    payloadSize,
    response,
    error,
  }) {
    try {
      await SyndicationLog.create({
        provider: 'ZILLOW',
        listingId,
        action,
        success,
        durationMs,
        requestPayloadSize: payloadSize,
        response,
        error,
      });
    } catch (logErr) {
      this.logger.error('Failed to write syndication log', {
        listingId,
        provider: 'ZILLOW',
        action,
        error: logErr.message,
      });
    }
  }

  async updateListingSyndicationState(listingId, patch) {
    const update = {};
    Object.entries(patch).forEach(([key, value]) => {
      update[`syndication.zillow.${key}`] = value;
    });
    await Listing.updateOne({ _id: listingId }, { $set: update });
  }

  async createOrUpdateListing(listing) {
    const listingId = listing._id || listing.id;
    const startedAt = ClockService.nowEpoch();
    const action = listing.syndication?.zillow?.published ? SYNDICATION_ACTIONS.UPDATE : SYNDICATION_ACTIONS.CREATE;

    try {
      const validation = await this.validateListing(listing);
      const normalized = normalizeListingForZillow(listing, this.config);
      const xml = buildHotPadsFeedXml([normalized], this.config);
      const payloadSize = Buffer.byteLength(xml, 'utf8');
      const feedListingId = validation.feedListingId;

      let realtimeResult = null;
      if (this.config.realtimeEnabled && this.config.apiKey) {
        realtimeResult = await this.realtimeApiClient.markForUpdate([feedListingId]);
      }

      await this.updateListingSyndicationState(listingId, {
        enabled: true,
        published: true,
        feedListingId,
        lastSyncedAt: ClockService.now(),
        lastSyncStatus: SYNDICATION_SYNC_STATUS.SUCCESS,
        lastSyncError: null,
        publishedAt: listing.syndication?.zillow?.publishedAt || ClockService.now(),
      });

      const result = {
        success: true,
        providerName: this.getProviderName(),
        listingId: String(listingId),
        message: 'Listing queued for Zillow sync',
        feedListingId,
        realtime: realtimeResult,
      };

      await this.logSyndicationAttempt({
        listingId,
        action,
        success: true,
        durationMs: ClockService.nowEpoch() - startedAt,
        payloadSize,
        response: result,
      });

      this.logger.info('Zillow listing sync succeeded', {
        listingId,
        provider: 'ZILLOW',
        action,
        feedListingId,
      });

      return result;
    } catch (error) {
      await this.updateListingSyndicationState(listingId, {
        lastSyncedAt: ClockService.now(),
        lastSyncStatus: SYNDICATION_SYNC_STATUS.FAILED,
        lastSyncError: error.message,
      });

      await this.logSyndicationAttempt({
        listingId,
        action,
        success: false,
        durationMs: ClockService.nowEpoch() - startedAt,
        error: error.message,
        response: { code: error.code, details: error.details, stack: error.stack },
      });

      this.logger.error('Zillow listing sync failed', {
        listingId,
        provider: 'ZILLOW',
        action,
        error: error.message,
        details: error.details,
      });

      return {
        success: false,
        providerName: this.getProviderName(),
        listingId: String(listingId),
        message: error.message,
        raw: error.details || error,
      };
    }
  }

  async removeListing(listing) {
    const listingId = listing._id || listing.id;
    const startedAt = ClockService.nowEpoch();
    const feedListingId = listing.syndication?.zillow?.feedListingId || toFeedListingId(listing);

    try {
      let realtimeResult = null;
      if (this.config.realtimeEnabled && this.config.apiKey && feedListingId) {
        realtimeResult = await this.realtimeApiClient.markForUpdate([feedListingId]);
      }

      const emptyXml = buildEmptyFeedXml();

      await this.updateListingSyndicationState(listingId, {
        published: false,
        unpublishedAt: ClockService.now(),
        lastSyncedAt: ClockService.now(),
        lastSyncStatus: SYNDICATION_SYNC_STATUS.SUCCESS,
        lastSyncError: null,
      });

      const result = {
        success: true,
        providerName: this.getProviderName(),
        listingId: String(listingId),
        message: 'Listing removed from Zillow syndication',
        feedListingId,
        removalXml: emptyXml,
        realtime: realtimeResult,
      };

      await this.logSyndicationAttempt({
        listingId,
        action: SYNDICATION_ACTIONS.REMOVE,
        success: true,
        durationMs: ClockService.nowEpoch() - startedAt,
        payloadSize: Buffer.byteLength(emptyXml, 'utf8'),
        response: result,
      });

      return result;
    } catch (error) {
      await this.updateListingSyndicationState(listingId, {
        lastSyncedAt: ClockService.now(),
        lastSyncStatus: SYNDICATION_SYNC_STATUS.FAILED,
        lastSyncError: error.message,
      });

      return {
        success: false,
        providerName: this.getProviderName(),
        listingId: String(listingId),
        message: error.message,
        raw: error,
      };
    }
  }

  async getSyncStatus(listing) {
    const feedListingId = listing.syndication?.zillow?.feedListingId || toFeedListingId(listing);

    try {
      const response = await this.httpClient.get(this.config.endpoints.getStatus, {
        params: {
          feedId: this.config.feedId,
          feedListingIds: feedListingId,
        },
        timeout: this.config.http?.timeoutMs || 30000,
      });

      const parsed = parseGetStatusResponse(response.data);
      return {
        success: true,
        providerName: this.getProviderName(),
        listingId: String(listing._id || listing.id),
        status: parsed.listings[0]?.status || 'UNKNOWN',
        message: parsed.listings[0]?.message,
        raw: parsed,
      };
    } catch (error) {
      return {
        success: false,
        providerName: this.getProviderName(),
        listingId: String(listing._id || listing.id),
        message: error.message,
        status: 'UNKNOWN',
      };
    }
  }
}

/**
 * resolve Street
 *
 * Performs logic operations for resolveStreet.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function resolveStreet(listing) {
  if (listing.street) return listing.street;
  if (listing.address) return String(listing.address).split(',')[0].trim();
  if (listing.propertyId?.address?.street) return listing.propertyId.address.street;
  return '';
}

module.exports = ZillowSyndicationProvider;
