/**
 * ------------------------------------------------------------------
 * File: listing.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for listing.
 *
 * Used By:
 * zillowFeedFileService, zillowFeedReportService, listing.model, listing.service
 * ------------------------------------------------------------------
 */

const LISTING_STATUS = {
  DRAFT: 'Draft',
  DRAFT_IN_PROGRESS: 'Draft_InProgress',
  PUBLISHED: 'Published',
  PUBLISH_IN_PROGRESS: 'Publish_InProgress',
  PUBLISH_ERROR: 'Publish_Error',
  PUBLISH_REJECTED: 'Publish_Rejected',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  DELETED: 'Deleted',
};

/** Listings included in the daily Zillow bulk feed (full snapshot each run). */
const ZILLOW_FEED_INCLUDE_STATUSES = [
  LISTING_STATUS.PUBLISHED,
  LISTING_STATUS.PUBLISH_IN_PROGRESS,
];

/** Listings whose status may change when a bulk feed is processed. */
const ZILLOW_FEED_PROCESS_STATUSES = [
  LISTING_STATUS.PUBLISHED,
  LISTING_STATUS.PUBLISH_IN_PROGRESS,
  LISTING_STATUS.DRAFT_IN_PROGRESS,
  LISTING_STATUS.PUBLISH_ERROR,
];

/** Listing statuses that are eligible for Zillow feed report processing. */
const ZILLOW_FEED_REPORT_PROCESS_STATUSES = [
  LISTING_STATUS.PUBLISHED,
  LISTING_STATUS.PUBLISH_IN_PROGRESS,
  LISTING_STATUS.DRAFT_IN_PROGRESS,
  LISTING_STATUS.PUBLISH_ERROR,
  LISTING_STATUS.PUBLISH_REJECTED,
];

const PAYMENT_FREQUENCY = {
  MONTHLY: 'Monthly',
  WEEKLY: 'Weekly',
  BI_WEEKLY: 'Bi-weekly',
  QUARTERLY: 'Quarterly',
  ANNUALLY: 'Annually',
};

const LEASE_TYPE = {
  FIXED_TERM: 'Fixed Term',
  MONTH_TO_MONTH: 'Month-to-Month',
  SHORT_TERM: 'Short Term',
};

module.exports = {
  LISTING_STATUS,
  ZILLOW_FEED_INCLUDE_STATUSES,
  ZILLOW_FEED_PROCESS_STATUSES,
  ZILLOW_FEED_REPORT_PROCESS_STATUSES,
  PAYMENT_FREQUENCY,
  LEASE_TYPE,
};
