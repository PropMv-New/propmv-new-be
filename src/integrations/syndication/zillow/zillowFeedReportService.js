/**
 * ------------------------------------------------------------------
 * File: zillowFeedReportService.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowFeedReportService.
 *
 * Used By:
 * zillow.routes
 * ------------------------------------------------------------------
 */

/**
 * Polls the Zillow feed run report and updates listing statuses:
 *   Accepted  → Published
 *   Rejected  → Publish_Rejected
 *   Blocked   → Publish_Rejected
 *   All other tracked listings → Draft
 */
const axios = require('axios');
const Listing = require('../../../portals/landlord/modules/listing/models/listing.model');
const SyndicationLog = require('../../../portals/landlord/modules/listing/models/syndicationLog.model');
const { ClockService, DateUtil } = require('../../../common/date');
const {
  LISTING_STATUS,
  ZILLOW_FEED_REPORT_PROCESS_STATUSES,
} = require('../../../common/constants/listing');
const { SYNDICATION_ACTIONS, SYNDICATION_SYNC_STATUS } = require('../syndication.constants');
const { parseFeedReport, REPORT_LISTING_STATUS } = require('./zillowFeedReportParser');

/**
 * ZillowFeedReportService
 *
 * Represents the Zillow Feed Report Service controller/model class.
 */
class ZillowFeedReportService {
  constructor({ config, logger, httpClient = null }) {
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient || axios.create({ timeout: 30000 });
  }

  /**
   * Builds the report URL for the configured feedId.
   * Uses mock URL when mockEnabled, otherwise real HotPads URL.
   */
  getReportUrl() {
    if (this.config.mockEnabled && this.config.reportMockUrl) {
      return this.config.reportMockUrl;
    }
    const feedId = this.config.feedId;
    return `https://feeds.hotpads.com/report/${feedId}/latest.txt`;
  }

  /**
   * Fetches the latest feed report text from Zillow (or mock).
   */
  async fetchReport() {
    const url = this.getReportUrl();
    const response = await this.httpClient.get(url, {
      responseType: 'text',
      validateStatus: (s) => s < 500,
    });

    if (response.status !== 200) {
      throw new Error(`Feed report fetch failed: HTTP ${response.status} from ${url}`);
    }

    return typeof response.data === 'string' ? response.data : String(response.data);
  }

  /**
   * Polls the report and applies status updates to tracked listings.
   * Returns a summary of changes made.
   */
  async pollAndProcess() {
    const startedAt = ClockService.nowEpoch();

    let reportText;
    try {
      reportText = await this.fetchReport();
    } catch (error) {
      this.logger.error('Zillow feed report fetch failed', {
        provider: 'ZILLOW',
        action: 'FEED_REPORT_POLL',
        error: error.message,
      });
      return { success: false, error: error.message };
    }

    const report = parseFeedReport(reportText);

    // Build lookup maps from report: feedListingId (normalized) → status
    const acceptedIds = new Set();
    const rejectedIds = new Set();

    for (const entry of report.listings) {
      const normalizedId = String(entry.id).replace(/[-_]/g, '').toLowerCase();
      if (entry.status === REPORT_LISTING_STATUS.ACCEPTED) {
        acceptedIds.add(normalizedId);
      } else {
        // Rejected or Blocked → Publish_Rejected
        rejectedIds.add(normalizedId);
      }
    }

    const trackedListings = await Listing.find({
      isDeleted: { $ne: true },
      status: { $in: ZILLOW_FEED_REPORT_PROCESS_STATUSES },
    }).lean();

    const now = ClockService.now();
    let publishedCount = 0;
    let rejectedCount = 0;
    let draftedCount = 0;
    const publishedIds = [];
    const rejectedListingIds = [];
    const draftedIds = [];

    for (const listing of trackedListings) {
      const feedId = String(
        listing.syndication?.zillow?.feedListingId || listing._id
      ).replace(/[-_]/g, '').toLowerCase();

      if (acceptedIds.has(feedId)) {
        await Listing.updateOne(
          { _id: listing._id },
          {
            $set: {
              status: LISTING_STATUS.PUBLISHED,
              'syndication.zillow.published': true,
              'syndication.zillow.lastSyncedAt': now,
              'syndication.zillow.lastSyncStatus': SYNDICATION_SYNC_STATUS.SUCCESS,
              'syndication.zillow.lastSyncError': null,
              'syndication.zillow.publishedAt': listing.syndication?.zillow?.publishedAt || now,
            },
          }
        );
        publishedCount += 1;
        publishedIds.push(String(listing._id));
      } else if (rejectedIds.has(feedId)) {
        await Listing.updateOne(
          { _id: listing._id },
          {
            $set: {
              status: LISTING_STATUS.PUBLISH_REJECTED,
              'syndication.zillow.published': false,
              'syndication.zillow.lastSyncedAt': now,
              'syndication.zillow.lastSyncStatus': SYNDICATION_SYNC_STATUS.FAILED,
              'syndication.zillow.lastSyncError': 'Listing rejected or blocked by Zillow feed report',
            },
          }
        );
        rejectedCount += 1;
        rejectedListingIds.push(String(listing._id));
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
        reportFeedId: report.feedId,
        runTimestamp: report.runTimestamp,
        reportListingCount: report.listings.length,
        publishedCount,
        rejectedCount,
        draftedCount,
        publishedIds,
        rejectedListingIds,
        draftedIds,
      },
    });

    this.logger.info('Zillow feed report processed - listing statuses updated', {
      provider: 'ZILLOW',
      action: 'FEED_REPORT_POLL',
      publishedCount,
      rejectedCount,
      draftedCount,
    });

    return {
      success: true,
      reportFeedId: report.feedId,
      runTimestamp: report.runTimestamp,
      reportListingCount: report.listings.length,
      publishedCount,
      rejectedCount,
      draftedCount,
      publishedIds,
      rejectedListingIds,
      draftedIds,
      durationMs,
    };
  }
}

module.exports = ZillowFeedReportService;
