/**
 * ------------------------------------------------------------------
 * File: zillowApiEndpoints.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowApiEndpoints.
 *
 * Used By:
 * zillowMockApi, zillow.config
 * ------------------------------------------------------------------
 */

/**
 * Official Zillow external API endpoints integrated by PropMv.
 * Path suffixes are identical across Zillow test and production hosts.
 *
 * Outbound (PropMv → Zillow):
 *   1. markForUpdate - Real-Time Listing API
 *   2. getStatus     - Syndication status API
 *
 * Inbound (Zillow → PropMv) are PropMv routes, not mocked here:
 *   - callback URL (listing XML)
 *   - bulk feed static URL (hotpads.xml)
 */
function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

/** Node may resolve localhost to ::1; use IPv4 loopback for in-process mock HTTP self-calls. */
function normalizeLoopbackUrl(url) {
  if (!url) return url;
  return String(url).replace(/\/\/localhost\b/gi, '//127.0.0.1');
}

/** Exact path suffixes from Zillow syndication documentation. */
const ZILLOW_EXTERNAL_API_PATHS = Object.freeze({
  MARK_FOR_UPDATE: '/listing-tools/api/v1/externalListing/markForUpdate',
  GET_STATUS: '/listing-tools/api/v1/syndication/getStatus',
  FEED_REPORT: '/report/:feedId/latest.txt',
});

/** Official Zillow hostnames (test vs production). */
const ZILLOW_EXTERNAL_API_HOSTS = Object.freeze({
  MARK_FOR_UPDATE_TEST: 'feeds.testpads.net',
  MARK_FOR_UPDATE_PROD: 'api.zillowrentals.com',
  GET_STATUS: 'listing-tools-api.hotpads.com',
});

/** All outbound Zillow APIs PropMv calls - used to register mock handlers. */
const ZILLOW_INTEGRATED_OUTBOUND_APIS = Object.freeze([
  {
    id: 'markForUpdate',
    method: 'GET',
    path: ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE,
    description: 'Real-Time Listing API - queue listings for callback fetch',
    testUrl: `https://${ZILLOW_EXTERNAL_API_HOSTS.MARK_FOR_UPDATE_TEST}${ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE}`,
    prodUrl: `https://${ZILLOW_EXTERNAL_API_HOSTS.MARK_FOR_UPDATE_PROD}${ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE}`,
    queryParams: ['apikey', 'feedId', 'feedListingIds'],
    responseFormat: 'xml',
  },
  {
    id: 'getStatus',
    method: 'GET',
    path: ZILLOW_EXTERNAL_API_PATHS.GET_STATUS,
    description: 'Syndication status API - live listing sync status',
    testUrl: `https://${ZILLOW_EXTERNAL_API_HOSTS.GET_STATUS}${ZILLOW_EXTERNAL_API_PATHS.GET_STATUS}`,
    prodUrl: `https://${ZILLOW_EXTERNAL_API_HOSTS.GET_STATUS}${ZILLOW_EXTERNAL_API_PATHS.GET_STATUS}`,
    queryParams: ['feedId', 'feedListingIds'],
    responseFormat: 'json',
  },
]);

/**
 * build Zillow Api Url
 *
 * Performs logic operations for buildZillowApiUrl.
 *
 * @param host - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function buildZillowApiUrl(host, path) {
  return `https://${host}${path}`;
}

/**
 * build Local Mock Api Url
 *
 * Performs logic operations for buildLocalMockApiUrl.
 *
 * @param publicBaseUrl - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function buildLocalMockApiUrl(publicBaseUrl, path) {
  return normalizeLoopbackUrl(`${trimTrailingSlash(publicBaseUrl)}${path}`);
}

/**
 * get Mark For Update Url
 *
 * Performs logic operations for getMarkForUpdateUrl.
 *
 * @param options - Request/input argument
 * @param mockEnabled - Request/input argument
 * @param publicBaseUrl - Request/input argument
 * @param env - Request/input argument
 * @returns Operations result
 */
function getMarkForUpdateUrl({ isProduction, mockEnabled, publicBaseUrl, env = process.env }) {
  if (mockEnabled) {
    if (env.ZILLOW_MARK_FOR_UPDATE_URL_MOCK) {
      return normalizeLoopbackUrl(env.ZILLOW_MARK_FOR_UPDATE_URL_MOCK);
    }
    return buildLocalMockApiUrl(publicBaseUrl, ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE);
  }
  if (isProduction) {
    return env.ZILLOW_MARK_FOR_UPDATE_URL_PROD
      || buildZillowApiUrl(
        ZILLOW_EXTERNAL_API_HOSTS.MARK_FOR_UPDATE_PROD,
        ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE
      );
  }
  return env.ZILLOW_MARK_FOR_UPDATE_URL_TEST
    || buildZillowApiUrl(
      ZILLOW_EXTERNAL_API_HOSTS.MARK_FOR_UPDATE_TEST,
      ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE
    );
}

/**
 * get Status Url
 *
 * Performs logic operations for getStatusUrl.
 *
 * @param options - Request/input argument
 * @param publicBaseUrl - Request/input argument
 * @param env - Request/input argument
 * @returns Operations result
 */
function getStatusUrl({ mockEnabled, publicBaseUrl, env = process.env }) {
  if (mockEnabled) {
    if (env.ZILLOW_GET_STATUS_URL_MOCK) {
      return normalizeLoopbackUrl(env.ZILLOW_GET_STATUS_URL_MOCK);
    }
    return buildLocalMockApiUrl(publicBaseUrl, ZILLOW_EXTERNAL_API_PATHS.GET_STATUS);
  }
  return env.ZILLOW_GET_STATUS_URL
    || buildZillowApiUrl(
      ZILLOW_EXTERNAL_API_HOSTS.GET_STATUS,
      ZILLOW_EXTERNAL_API_PATHS.GET_STATUS
    );
}

module.exports = {
  ZILLOW_EXTERNAL_API_PATHS,
  ZILLOW_EXTERNAL_API_HOSTS,
  ZILLOW_INTEGRATED_OUTBOUND_APIS,
  buildZillowApiUrl,
  buildLocalMockApiUrl,
  normalizeLoopbackUrl,
  getMarkForUpdateUrl,
  getStatusUrl,
};
