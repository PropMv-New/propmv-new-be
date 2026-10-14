/**
 * ------------------------------------------------------------------
 * File: syndication.constants.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for syndication.constants.
 *
 * Used By:
 * SyndicationProviderFactory, zillowFeedFileService, zillowFeedReportService, ZillowSyndicationProvider
 * ------------------------------------------------------------------
 */

/**
 * Supported syndication provider identifiers.
 * Extend this enum when adding Apartments.com, Realtor.com, etc.
 */
const SYNDICATION_PROVIDERS = Object.freeze({
  ZILLOW: 'ZILLOW',
  // TODO: extend for additional providers
  APARTMENTS_COM: 'APARTMENTS_COM',
  REALTOR_COM: 'REALTOR_COM',
});

const SYNDICATION_ACTIONS = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  REMOVE: 'REMOVE',
  BULK_FEED: 'BULK_FEED',
  STATUS_CHECK: 'STATUS_CHECK',
});

const SYNDICATION_SYNC_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  PENDING: 'PENDING',
});

module.exports = {
  SYNDICATION_PROVIDERS,
  SYNDICATION_ACTIONS,
  SYNDICATION_SYNC_STATUS,
};
