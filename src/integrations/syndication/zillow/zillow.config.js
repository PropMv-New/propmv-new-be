/**
 * ------------------------------------------------------------------
 * File: zillow.config.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Configuration settings, variables mapping, and constants definitions.
 *
 * Used By:
 * app, SyndicationProviderFactory, zillow.routes, zillowBulkFeedCronJob
 * ------------------------------------------------------------------
 */

/**
 * Zillow Rentals (ZGR) environment configuration.
 * Every endpoint, route prefix, and tunable value is read from process.env.
 * Defaults match Zillow's official test/production URLs from their syndication guides.
 */
const path = require('path');
const {
  ZILLOW_EXTERNAL_API_PATHS,
  ZILLOW_INTEGRATED_OUTBOUND_APIS,
  getMarkForUpdateUrl,
  getStatusUrl,
  normalizeLoopbackUrl,
} = require('./zillowApiEndpoints');

/**
 * env Bool
 *
 * Performs logic operations for envBool.
 *
 * @param name - Request/input argument
 * @param defaultValue - Request/input argument
 * @returns Operations result
 */
function envBool(name, defaultValue = 'true') {
  return (process.env[name] ?? defaultValue).toString().toLowerCase() === 'true';
}

/**
 * env Number
 *
 * Performs logic operations for envNumber.
 *
 * @param name - Request/input argument
 * @param defaultValue - Request/input argument
 * @returns Operations result
 */
function envNumber(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

/**
 * trim Trailing Slash
 *
 * Performs logic operations for trimTrailingSlash.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

const isProduction = (process.env.ZILLOW_ENV || 'test') === 'production';
const mockEnabled = envBool('ZILLOW_MOCK_ENABLED', 'false');

const MOCK_DEFAULTS = {
  apiKey: process.env.ZILLOW_MOCK_API_KEY || 'mock-zillow-api-key',
  feedId: process.env.ZILLOW_MOCK_FEED_ID || 'mock-feed-id',
  companyId: process.env.ZILLOW_MOCK_COMPANY_ID || 'mock-company-id',
};

/**
 * get Api Key
 *
 * Performs logic operations for getApiKey.
 *
 * @returns Operations result
 */
function getApiKey() {
  if (isProduction) {
    const prodKey = process.env.ZILLOW_API_KEY_PROD || '';
    if (prodKey) return prodKey;
    return mockEnabled ? MOCK_DEFAULTS.apiKey : '';
  }
  const testKey = process.env.ZILLOW_API_KEY_TEST || process.env.ZILLOW_API_KEY_PROD || '';
  if (testKey) return testKey;
  return mockEnabled ? MOCK_DEFAULTS.apiKey : '';
}

/**
 * get Feed Id
 *
 * Performs logic operations for getFeedId.
 *
 * @returns Operations result
 */
function getFeedId() {
  const configured = process.env.ZILLOW_FEED_ID || '';
  if (configured) return configured;
  return mockEnabled ? MOCK_DEFAULTS.feedId : '';
}

/**
 * get Company Id
 *
 * Performs logic operations for getCompanyId.
 *
 * @returns Operations result
 */
function getCompanyId() {
  const configured = process.env.ZILLOW_COMPANY_ID || '';
  if (configured) return configured;
  return mockEnabled ? MOCK_DEFAULTS.companyId : '';
}

const rawApiPublicBaseUrl = trimTrailingSlash(
  process.env.API_PUBLIC_BASE_URL
  || process.env.APP_PUBLIC_BASE_URL
  || `http://127.0.0.1:${process.env.PORT || 5000}`
);
const apiPublicBaseUrl = mockEnabled
  ? normalizeLoopbackUrl(rawApiPublicBaseUrl)
  : rawApiPublicBaseUrl;

const apiBasePath = process.env.API_BASE_PATH || '/api/v1';
const zillowApiRoutePrefix = process.env.ZILLOW_API_ROUTE_PREFIX || '/api/v1/zillow';
const bulkFeedPublicPath = process.env.ZILLOW_BULK_FEED_PUBLIC_PATH || '/feeds/zillow';
const bulkFeedFileName = process.env.ZILLOW_BULK_FEED_FILENAME || 'hotpads.xml';
const feedId = getFeedId();
const reportMockUrl = mockEnabled
  ? normalizeLoopbackUrl(`${rawApiPublicBaseUrl}/report/${feedId || 'mock-feed-id'}/latest.txt`)
  : null;

const zillowConfig = {
  env: isProduction ? 'production' : 'test',
  isProduction,
  mockEnabled,
  mockApiKey: MOCK_DEFAULTS.apiKey,
  mockSimulateCallback: envBool('ZILLOW_MOCK_SIMULATE_CALLBACK', 'true'),
  mockCallbackDelayMs: envNumber('ZILLOW_MOCK_CALLBACK_DELAY_MS', 500),
  enabled: envBool('ZILLOW_SYNDICATION_ENABLED', 'true'),
  apiKey: getApiKey(),
  feedId: getFeedId(),
  companyId: getCompanyId(),
  contactEmail: process.env.ZILLOW_DEFAULT_CONTACT_EMAIL || '',
  contactPhone: process.env.ZILLOW_DEFAULT_CONTACT_PHONE || '',
  contactName: process.env.ZILLOW_DEFAULT_CONTACT_NAME || 'Leasing Office',
  contactMethodPreference: process.env.ZILLOW_DEFAULT_CONTACT_METHOD || 'Email',
  companyName: process.env.ZILLOW_COMPANY_NAME || '',
  companyWebsite: process.env.ZILLOW_COMPANY_WEBSITE || '',
  companyCity: process.env.ZILLOW_COMPANY_CITY || '',
  companyState: process.env.ZILLOW_COMPANY_STATE || '',
  applicationFee: envNumber('ZILLOW_DEFAULT_APPLICATION_FEE', 50),
  providerType: process.env.ZILLOW_PROVIDER_TYPE || 'propertyManager',
  costAndFeeDescription: process.env.ZILLOW_COST_FEE_DESCRIPTION
    || 'Fees are subject to change. See lease for full details.',
  signupUrl: process.env.ZILLOW_SIGNUP_URL || 'https://www.zillow.com/rentals-network/listing-feeds/',
  realtimeEnabled: envBool('ZILLOW_REALTIME_ENABLED', 'true'),
  bulkFeedEnabled: envBool('ZILLOW_BULK_FEED_ENABLED', 'true'),
  bulkFeedCronEnabled: envBool('ZILLOW_BULK_FEED_CRON_ENABLED', 'true'),
  reportMockUrl,
  compressFeed: envBool('ZILLOW_BULK_FEED_GZIP', 'true'),
  thresholdPercent: envNumber('ZILLOW_BULK_FEED_THRESHOLD_PERCENT', 20),
  bulkFeedPublicPath,
  bulkFeedLocalDir: process.env.ZILLOW_BULK_FEED_LOCAL_DIR
    || path.join(__dirname, '../../../../public/feeds/zillow'),
  bulkFeedFileName,
  bulkFeedRunHoursEt: (process.env.ZILLOW_BULK_FEED_RUN_HOURS_ET || '4,16')
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => !Number.isNaN(h)),
  bulkFeedRunMinuteEt: envNumber('ZILLOW_BULK_FEED_RUN_MINUTE_ET', 30),
  bulkFeedStartupDelayMs: envNumber('ZILLOW_BULK_FEED_STARTUP_DELAY_MS', 120000),
  apiPublicBaseUrl,
  apiBasePath,
  routes: {
    apiPrefix: zillowApiRoutePrefix,
    callback: process.env.ZILLOW_CALLBACK_ROUTE || '/callback',
    bulkFeedRegenerate: process.env.ZILLOW_BULK_FEED_REGENERATE_ROUTE || '/bulk-feed/regenerate',
    bulkFeedConfirm: process.env.ZILLOW_BULK_FEED_CONFIRM_ROUTE || '/bulk-feed/confirm',
    landlordSyndicationStatus: process.env.ZILLOW_LANDLORD_SYNDICATION_STATUS_ROUTE
      || '/listing/listings/:id/syndication',
    landlordSyndicationLive: process.env.ZILLOW_LANDLORD_SYNDICATION_LIVE_ROUTE
      || '/listing/listings/:id/syndication/live',
    landlordSyndicationSync: process.env.ZILLOW_LANDLORD_SYNDICATION_SYNC_ROUTE
      || '/listing/listings/:id/syndication/zillow/sync',
    landlordSyndicationRemove: process.env.ZILLOW_LANDLORD_SYNDICATION_REMOVE_ROUTE
      || '/listing/listings/:id/syndication/zillow/remove',
  },
  urls: {
    callback: (mockEnabled ? normalizeLoopbackUrl : (url) => url)(
      process.env.ZILLOW_CALLBACK_URL
        || `${apiPublicBaseUrl}${zillowApiRoutePrefix}${process.env.ZILLOW_CALLBACK_ROUTE || '/callback'}`
    ),
    bulkFeed: process.env.ZILLOW_BULK_FEED_PUBLIC_URL
      || `${apiPublicBaseUrl}${bulkFeedPublicPath}/${bulkFeedFileName}`,
    bulkFeedRegenerate: process.env.ZILLOW_BULK_FEED_REGENERATE_URL
      || `${apiPublicBaseUrl}${zillowApiRoutePrefix}${process.env.ZILLOW_BULK_FEED_REGENERATE_ROUTE || '/bulk-feed/regenerate'}`,
    bulkFeedConfirm: process.env.ZILLOW_BULK_FEED_CONFIRM_URL
      || `${apiPublicBaseUrl}${zillowApiRoutePrefix}${process.env.ZILLOW_BULK_FEED_CONFIRM_ROUTE || '/bulk-feed/confirm'}`,
    landlordSyndicationStatus: process.env.ZILLOW_LANDLORD_SYNDICATION_STATUS_URL
      || `${apiPublicBaseUrl}${apiBasePath}/landlord/listing/listings/:id/syndication`,
    landlordSyndicationSync: process.env.ZILLOW_LANDLORD_SYNDICATION_SYNC_URL
      || `${apiPublicBaseUrl}${apiBasePath}/landlord/listing/listings/:id/syndication/zillow/sync`,
    landlordSyndicationRemove: process.env.ZILLOW_LANDLORD_SYNDICATION_REMOVE_URL
      || `${apiPublicBaseUrl}${apiBasePath}/landlord/listing/listings/:id/syndication/zillow/remove`,
    signup: process.env.ZILLOW_SIGNUP_URL || 'https://www.zillow.com/rentals-network/listing-feeds/',
  },
  endpoints: {
    markForUpdate: getMarkForUpdateUrl({
      isProduction,
      mockEnabled,
      publicBaseUrl: apiPublicBaseUrl,
    }),
    getStatus: getStatusUrl({
      mockEnabled,
      publicBaseUrl: apiPublicBaseUrl,
    }),
    markForUpdateTest: getMarkForUpdateUrl({
      isProduction: false,
      mockEnabled,
      publicBaseUrl: apiPublicBaseUrl,
    }),
    markForUpdateProd: getMarkForUpdateUrl({
      isProduction: true,
      mockEnabled: false,
      publicBaseUrl: apiPublicBaseUrl,
    }),
  },
  externalApiPaths: ZILLOW_EXTERNAL_API_PATHS,
  integratedOutboundApis: ZILLOW_INTEGRATED_OUTBOUND_APIS,
  http: {
    timeoutMs: envNumber('ZILLOW_HTTP_TIMEOUT_MS', 30000),
    maxRetries: envNumber('ZILLOW_HTTP_MAX_RETRIES', 3),
    retryBaseDelayMs: envNumber('ZILLOW_HTTP_RETRY_BASE_DELAY_MS', 500),
  },
  platformId: process.env.ZILLOW_PLATFORM_ID || 'zillow',
};

module.exports = zillowConfig;
