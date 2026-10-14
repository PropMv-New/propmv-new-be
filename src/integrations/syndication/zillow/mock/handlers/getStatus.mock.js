/**
 * ------------------------------------------------------------------
 * File: getStatus.mock.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for getStatus.mock.
 *
 * Used By:
 * zillowMockApi
 * ------------------------------------------------------------------
 */

/**
 * Mock handler for Zillow syndication getStatus API.
 * Path: GET /listing-tools/api/v1/syndication/getStatus
 * Query: feedId, feedListingIds
 * Response: JSON { success, listings: [...] }
 */
const mockState = require('../zillowMockState');

/**
 * parse Feed Listing Ids Param
 *
 * Performs logic operations for parseFeedListingIdsParam.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function parseFeedListingIdsParam(value) {
  return String(value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * create Get Status Handler
 *
 * Performs logic operations for createGetStatusHandler.
 *
 * @returns Operations result
 */
function createGetStatusHandler() {
  return function handleGetStatus(req, res) {
    const feedId = req.query.feedId;
    const feedListingIds = parseFeedListingIdsParam(req.query.feedListingIds);

    if (!feedId) {
      return res.status(400).json({ success: false, message: 'feedId is required', listings: [] });
    }

    if (!feedListingIds.length) {
      return res.status(400).json({ success: false, message: 'feedListingIds is required', listings: [] });
    }

    const listings = mockState.getStatusForIds(feedListingIds, feedId);
    return res.status(200).json({ success: true, listings });
  };
}

module.exports = {
  createGetStatusHandler,
};
