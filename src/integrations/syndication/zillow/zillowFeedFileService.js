/**
 * ------------------------------------------------------------------
 * File: zillowFeedFileService.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowFeedFileService.
 *
 * Used By:
 * zillow.routes, ZillowSyndicationProvider, zillowBulkFeedCronJob
 * ------------------------------------------------------------------
 */

const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { ClockService, DateUtil } = require('../../../common/date');
const gzip = promisify(zlib.gzip);

const Listing = require('../../../portals/landlord/modules/listing/models/listing.model');
const SyndicationLog = require('../../../portals/landlord/modules/listing/models/syndicationLog.model');
const ZillowFeedState = require('../../../portals/landlord/modules/listing/models/zillowFeedState.model');
const {
  LISTING_STATUS,
  ZILLOW_FEED_INCLUDE_STATUSES,
  ZILLOW_FEED_PROCESS_STATUSES,
} = require('../../../common/constants/listing');
const { SYNDICATION_ACTIONS, SYNDICATION_SYNC_STATUS } = require('../syndication.constants');
const {
  buildHotPadsFeedXml,
  normalizeListingForZillow,
  extractListingIdsFromFeedXml,
  toFeedListingId,
} = require('./zillowXmlBuilder');
const { ZillowFeedError } = require('./zillow.errors');
const {
  enrichListingUnitFieldsFromProperty,
  LISTING_PROPERTY_UNIT_SELECT,
} = require('../../../portals/landlord/modules/listing/helpers/listingUnitFields.helper');

/**
 * listing Has Zillow Platform
 *
 * Performs logic operations for listingHasZillowPlatform.
 *
 * @param listing - Request/input argument
 * @returns Operations result
 */
function listingHasZillowPlatform(listing) {
  const platforms = listing?.syndicationPlatforms || [];
  return platforms.some((p) => String(p).toLowerCase() === 'zillow');
}

/**
 * Generates and publishes the static Zillow bulk feed snapshot.
 * The feed file is the single source of truth - every run includes ALL live listings.
 */
class ZillowFeedFileService {
  constructor({ config, logger, xmlBuilder = null }) {
    this.config = config;
    this.logger = logger;
    this.xmlBuilder = xmlBuilder || {
      buildHotPadsFeedXml,
      normalizeListingForZillow,
      extractListingIdsFromFeedXml,
      toFeedListingId,
    };
  }

  getFeedFilePath() {
    return path.join(this.config.bulkFeedLocalDir, this.config.bulkFeedFileName);
  }

  async ensureOutputDir() {
    await fs.mkdir(this.config.bulkFeedLocalDir, { recursive: true });
  }

  /**
   * Queries every listing that should appear in the next bulk feed snapshot.
   * Includes Published + Publish_InProgress with Zillow selected.
   */
  async fetchFeedEligibleListings() {
    const listings = await Listing.find({
      isDeleted: { $ne: true },
      status: { $in: ZILLOW_FEED_INCLUDE_STATUSES },
    })
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

    return listings
      .filter((listing) => listingHasZillowPlatform(listing))
      .map((listing) =>
        this.xmlBuilder.normalizeListingForZillow(
          enrichListingUnitFieldsFromProperty(listing),
          this.config
        )
      );
  }

  /** @deprecated Use fetchFeedEligibleListings */
  async fetchPublishedZillowListings() {
    return this.fetchFeedEligibleListings();
  }

  async getLastSuccessfulListingCount() {
    const state = await ZillowFeedState.findOne({ feedId: this.config.feedId }).lean();
    return state?.lastSuccessfulListingCount ?? null;
  }

  async checkThreshold(newCount) {
    const lastCount = await this.getLastSuccessfulListingCount();
    if (lastCount == null || lastCount === 0) {
      return { proceed: true, reason: 'no_baseline' };
    }

    const delta = Math.abs(newCount - lastCount);
    const percentChange = (delta / lastCount) * 100;
    const threshold = this.config.thresholdPercent || 20;

    if (percentChange > threshold) {
      await ZillowFeedState.findOneAndUpdate(
        { feedId: this.config.feedId },
        {
          $set: {
            pendingConfirmation: true,
            pendingListingCount: newCount,
            lastThresholdBreachAt: ClockService.now(),
            lastThresholdPercent: percentChange,
          },
        },
        { upsert: true }
      );

      this.logger.warn('Zillow bulk feed threshold breach - manual confirmation required', {
        provider: 'ZILLOW',
        action: SYNDICATION_ACTIONS.BULK_FEED,
        lastCount,
        newCount,
        percentChange: percentChange.toFixed(2),
        threshold,
      });

      return {
        proceed: false,
        reason: 'threshold_exceeded',
        lastCount,
        newCount,
        percentChange,
        threshold,
      };
    }

    return { proceed: true, reason: 'within_threshold', lastCount, newCount, percentChange };
  }

  async writeFeedFile(xmlContent) {
    await this.ensureOutputDir();
    const filePath = this.getFeedFilePath();
    await fs.writeFile(filePath, xmlContent, 'utf8');

    if (this.config.compressFeed) {
      const gzPath = `${filePath}.gz`;
      const compressed = await gzip(Buffer.from(xmlContent, 'utf8'));
      await fs.writeFile(gzPath, compressed);
    }

    return {
      filePath,
      fileSize: Buffer.byteLength(xmlContent, 'utf8'),
    };
  }

  /**
   * Generates the bulk feed XML from all eligible listings and writes it to disk.
   */
  async generateBulkFeedFile({ force = false } = {}) {
    return this.regenerateFeed({ force });
  }

  /**
   * Regenerates bulk feed. Skips publish if threshold breached unless force=true.
   */
  async regenerateFeed({ force = false } = {}) {
    const startedAt = ClockService.nowEpoch();
    let logEntry = null;

    try {
      const listings = await this.config.bulkFeedEnabled === false
        ? []
        : await this.fetchFeedEligibleListings();

      const xml = this.xmlBuilder.buildHotPadsFeedXml(listings, this.config);
      const listingCount = listings.length;

      if (!force) {
        const threshold = await this.checkThreshold(listingCount);
        if (!threshold.proceed) {
          logEntry = await SyndicationLog.create({
            provider: 'ZILLOW',
            action: SYNDICATION_ACTIONS.BULK_FEED,
            success: false,
            durationMs: ClockService.nowEpoch() - startedAt,
            requestPayloadSize: Buffer.byteLength(xml, 'utf8'),
            response: threshold,
            error: `Threshold exceeded: ${threshold.percentChange?.toFixed(2)}% change (max ${threshold.threshold}%)`,
          });

          return {
            success: false,
            skipped: true,
            reason: threshold.reason,
            listingCount,
            threshold,
            logId: logEntry._id,
          };
        }
      }

      const { filePath, fileSize } = await this.writeFeedFile(xml);

      await ZillowFeedState.findOneAndUpdate(
        { feedId: this.config.feedId },
        {
          $set: {
            lastSuccessfulRunAt: ClockService.now(),
            lastSuccessfulListingCount: listingCount,
            lastFilePath: filePath,
            lastFileSize: fileSize,
            pendingConfirmation: false,
          },
        },
        { upsert: true }
      );

      const durationMs = ClockService.nowEpoch() - startedAt;
      logEntry = await SyndicationLog.create({
        provider: 'ZILLOW',
        action: SYNDICATION_ACTIONS.BULK_FEED,
        success: true,
        durationMs,
        requestPayloadSize: fileSize,
        response: { listingCount, filePath, fileSize, feedListingIds: listings.map((l) => toFeedListingId(l)) },
      });

      this.logger.info('Zillow bulk feed regenerated', {
        provider: 'ZILLOW',
        action: SYNDICATION_ACTIONS.BULK_FEED,
        listingCount,
        fileSize,
        durationMs,
      });

      return {
        success: true,
        listingCount,
        filePath,
        fileSize,
        durationMs,
        logId: logEntry._id,
        feedListingIds: listings.map((l) => toFeedListingId(l)),
      };
    } catch (error) {
      const durationMs = ClockService.nowEpoch() - startedAt;
      await SyndicationLog.create({
        provider: 'ZILLOW',
        action: SYNDICATION_ACTIONS.BULK_FEED,
        success: false,
        durationMs,
        error: error.message,
        response: { stack: error.stack },
      });

      this.logger.error('Zillow bulk feed regeneration failed', {
        provider: 'ZILLOW',
        action: SYNDICATION_ACTIONS.BULK_FEED,
        error: error.message,
      });

      throw new ZillowFeedError(error.message, { cause: error });
    }
  }

  /**
   * Reads the on-disk feed file and applies final listing statuses.
   * Listings present in the file → Published; all other syndication-tracked listings → Draft.
   */
  async processFeedFileStatuses({ filePath } = {}) {
    const startedAt = ClockService.nowEpoch();
    const resolvedPath = filePath || this.getFeedFilePath();

    let xml;
    try {
      xml = await fs.readFile(resolvedPath, 'utf8');
    } catch (error) {
      return {
        success: false,
        reason: 'feed_file_not_found',
        message: 'Feed file does not exist. Call /mock/bulk-feed/generate first.',
        filePath: resolvedPath,
      };
    }

    const feedListingIds = new Set(
      this.xmlBuilder.extractListingIdsFromFeedXml(xml).map((id) => String(id).replace(/[-_]/g, ''))
    );

    const trackedListings = await Listing.find({
      isDeleted: { $ne: true },
      status: { $in: ZILLOW_FEED_PROCESS_STATUSES },
    }).lean();

    const now = ClockService.now();
    let publishedCount = 0;
    let draftedCount = 0;
    const publishedIds = [];
    const draftedIds = [];

    for (const listing of trackedListings) {
      const feedId = toFeedListingId(listing);
      const inFeed = feedListingIds.has(feedId);

      if (inFeed) {
        await Listing.updateOne(
          { _id: listing._id },
          {
            $set: {
              status: LISTING_STATUS.PUBLISHED,
              'syndication.zillow.enabled': true,
              'syndication.zillow.published': true,
              'syndication.zillow.feedListingId': feedId,
              'syndication.zillow.lastSyncedAt': now,
              'syndication.zillow.lastSyncStatus': SYNDICATION_SYNC_STATUS.SUCCESS,
              'syndication.zillow.lastSyncError': null,
              'syndication.zillow.publishedAt': listing.syndication?.zillow?.publishedAt || now,
            },
          }
        );
        publishedCount += 1;
        publishedIds.push(String(listing._id));
      } else {
        await Listing.updateOne(
          { _id: listing._id },
          {
            $set: {
              status: LISTING_STATUS.DRAFT,
              'syndication.zillow.published': false,
              'syndication.zillow.lastSyncedAt': now,
              'syndication.zillow.lastSyncStatus': SYNDICATION_SYNC_STATUS.SUCCESS,
              'syndication.zillow.lastSyncError': null,
              'syndication.zillow.unpublishedAt': now,
            },
          }
        );
        draftedCount += 1;
        draftedIds.push(String(listing._id));
      }
    }

    const durationMs = ClockService.nowEpoch() - startedAt;
    await SyndicationLog.create({
      provider: 'ZILLOW',
      action: SYNDICATION_ACTIONS.STATUS_CHECK,
      success: true,
      durationMs,
      response: {
        filePath: resolvedPath,
        feedListingCount: feedListingIds.size,
        publishedCount,
        draftedCount,
        publishedIds,
        draftedIds,
      },
    });

    this.logger.info('Zillow bulk feed processed - listing statuses updated', {
      provider: 'ZILLOW',
      action: 'BULK_FEED_PROCESS',
      publishedCount,
      draftedCount,
      feedListingCount: feedListingIds.size,
    });

    return {
      success: true,
      filePath: resolvedPath,
      feedListingCount: feedListingIds.size,
      publishedCount,
      draftedCount,
      publishedIds,
      draftedIds,
      durationMs,
    };
  }

  async buildCallbackXmlForIds(feedListingIds = []) {
    const normalizedIds = feedListingIds.map((id) => String(id).replace(/[-_]/g, ''));

    const listings = await Listing.find({
      isDeleted: { $ne: true },
      status: { $in: ZILLOW_FEED_INCLUDE_STATUSES },
      $or: [
        { 'syndication.zillow.feedListingId': { $in: normalizedIds } },
        {
          $expr: {
            $in: [
              { $replaceAll: { input: { $toString: '$_id' }, find: '-', replacement: '' } },
              normalizedIds,
            ],
          },
        },
      ],
    })
      .populate({
        path: 'propertyId',
        select: LISTING_PROPERTY_UNIT_SELECT,
      })
      .populate({
        path: 'images.documentMetaDataId',
        select: 's3Location key',
      })
      .lean();

    const normalized = listings
      .filter((l) => listingHasZillowPlatform(l))
      .map((l) =>
        this.xmlBuilder.normalizeListingForZillow(
          enrichListingUnitFieldsFromProperty(l),
          this.config
        )
      );

    return this.xmlBuilder.buildHotPadsFeedXml(normalized, this.config);
  }
}

module.exports = ZillowFeedFileService;
