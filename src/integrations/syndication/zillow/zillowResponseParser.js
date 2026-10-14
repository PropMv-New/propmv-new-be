/**
 * ------------------------------------------------------------------
 * File: zillowResponseParser.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowResponseParser.
 *
 * Used By:
 * zillowRealtimeApiClient, ZillowSyndicationProvider
 * ------------------------------------------------------------------
 */

/**
 * Parses Zillow API XML/JSON responses.
 * Note: markForUpdate success element is spelled "succes" in Zillow's API (their typo).
 */
function parseMarkForUpdateResponse(xmlOrString) {
  const text = String(xmlOrString || '');
  const successMatch = text.match(/<succes>(true|false)<\/succes>/i)
    || text.match(/<success>(true|false)<\/success>/i);
  const queuedMatch = text.match(/<queued>(\d+)<\/queued>/i);

  return {
    success: successMatch ? successMatch[1].toLowerCase() === 'true' : false,
    queued: queuedMatch ? Number(queuedMatch[1]) : 0,
  };
}

/**
 * parse Get Status Response
 *
 * Performs logic operations for parseGetStatusResponse.
 *
 * @param data - Request/input argument
 * @returns Operations result
 */
function parseGetStatusResponse(data) {
  if (!data) {
    return { success: false, listings: [] };
  }

  if (typeof data === 'string') {
    try {
      return parseGetStatusResponse(JSON.parse(data));
    } catch {
      return { success: false, listings: [], raw: data };
    }
  }

  const listings = Array.isArray(data.listings)
    ? data.listings
    : Array.isArray(data.results)
      ? data.results
      : [];

  return {
    success: true,
    listings: listings.map((item) => ({
      feedListingId: item.feedListingId || item.listingId || item.id,
      status: item.status || item.syndicationStatus || 'UNKNOWN',
      lastUpdated: item.lastUpdated || item.updatedAt,
      message: item.message,
    })),
    raw: data,
  };
}

module.exports = {
  parseMarkForUpdateResponse,
  parseGetStatusResponse,
};
