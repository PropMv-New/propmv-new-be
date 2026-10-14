/**
 * ------------------------------------------------------------------
 * File: zillowMockState.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowMockState.
 *
 * Used By:
 * getStatus.mock, markForUpdate.mock, zillowMockApi
 * ------------------------------------------------------------------
 */

/**
 * In-memory state for the Zillow mock API.
 * Tracks syndication status per feedListingId for getStatus responses.
 */
const { ClockService, DateUtil } = require('../../../../common/date');
const listingState = new Map();

const STATUS = {
  PENDING: 'PENDING',
  LIVE: 'LIVE',
  REMOVED: 'REMOVED',
  UNKNOWN: 'UNKNOWN',
};

/**
 * normalize Feed Listing Id
 *
 * Performs logic operations for normalizeFeedListingId.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function normalizeFeedListingId(id) {
  return String(id || '').replace(/[-_]/g, '').trim();
}

/**
 * get Listing
 *
 * Performs logic operations for getListing.
 *
 * @param feedListingId - Request/input argument
 * @returns Operations result
 */
function getListing(feedListingId) {
  const key = normalizeFeedListingId(feedListingId);
  return listingState.get(key) || null;
}

/**
 * mark For Update
 *
 * Performs logic operations for markForUpdate.
 *
 * @param options - Request/input argument
 * @param feedId - Request/input argument
 * @param action - Request/input argument
 * @returns Operations result
 */
function markForUpdate({ feedListingIds, feedId, action = 'update' }) {
  const ids = (Array.isArray(feedListingIds) ? feedListingIds : [feedListingIds])
    .map(normalizeFeedListingId)
    .filter(Boolean);

  const now = DateUtil.toISO(ClockService.now());
  ids.forEach((id) => {
    const existing = listingState.get(id);
    listingState.set(id, {
      feedListingId: id,
      feedId: feedId || existing?.feedId || '',
      status: action === 'remove' ? STATUS.REMOVED : STATUS.PENDING,
      lastUpdated: now,
      message: action === 'remove'
        ? 'Listing marked for removal (mock)'
        : 'Listing queued for sync (mock)',
      markedAt: now,
      callbackFetchedAt: existing?.callbackFetchedAt || null,
    });
  });

  return ids;
}

/**
 * mark Callback Fetched
 *
 * Performs logic operations for markCallbackFetched.
 *
 * @param feedListingIds - Request/input argument
 * @param meta - Request/input argument
 * @returns Operations result
 */
function markCallbackFetched(feedListingIds, meta = {}) {
  const now = DateUtil.toISO(ClockService.now());
  const ids = (Array.isArray(feedListingIds) ? feedListingIds : [feedListingIds])
    .map(normalizeFeedListingId)
    .filter(Boolean);

  ids.forEach((id) => {
    const existing = listingState.get(id);
    if (!existing || existing.status === STATUS.REMOVED) return;
    listingState.set(id, {
      ...existing,
      status: STATUS.LIVE,
      lastUpdated: now,
      callbackFetchedAt: now,
      message: 'Listing live on Zillow (mock)',
      lastCallbackXml: {
        valid: meta.callbackXmlValid ?? null,
        errors: meta.callbackXmlErrors || [],
        length: meta.callbackXmlLength ?? 0,
      },
    });
  });
}

/**
 * get Status For Ids
 *
 * Performs logic operations for getStatusForIds.
 *
 * @param feedListingIds - Request/input argument
 * @param feedId - Request/input argument
 * @returns Operations result
 */
function getStatusForIds(feedListingIds, feedId) {
  const ids = (Array.isArray(feedListingIds) ? feedListingIds : [feedListingIds])
    .map(normalizeFeedListingId)
    .filter(Boolean);

  return ids.map((id) => {
    const entry = listingState.get(id);
    if (!entry) {
      return {
        feedListingId: id,
        status: STATUS.UNKNOWN,
        lastUpdated: null,
        message: 'Listing not found in mock Zillow (never marked for update)',
      };
    }
    if (feedId && entry.feedId && entry.feedId !== feedId) {
      return {
        feedListingId: id,
        status: STATUS.UNKNOWN,
        lastUpdated: entry.lastUpdated,
        message: 'feedId mismatch',
      };
    }
    return {
      feedListingId: entry.feedListingId,
      status: entry.status,
      lastUpdated: entry.lastUpdated,
      message: entry.message,
    };
  });
}

/**
 * reset
 *
 * Performs logic operations for reset.
 *
 * @returns Operations result
 */
function reset() {
  listingState.clear();
}

/**
 * snapshot
 *
 * Performs logic operations for snapshot.
 *
 * @returns Operations result
 */
function snapshot() {
  return Object.fromEntries(listingState);
}

module.exports = {
  STATUS,
  normalizeFeedListingId,
  getListing,
  markForUpdate,
  markCallbackFetched,
  getStatusForIds,
  reset,
  snapshot,
};
