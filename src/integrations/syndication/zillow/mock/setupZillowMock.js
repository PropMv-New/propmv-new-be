/**
 * ------------------------------------------------------------------
 * File: setupZillowMock.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for setupZillowMock.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const logger = require('../../../../common/logger');
const {
  createZillowMockRouter,
  getMockApiCatalog,
  ZILLOW_INTEGRATED_OUTBOUND_APIS,
} = require('./zillowMockApi');

/**
 * Mount mock Zillow external API routes when ZILLOW_MOCK_ENABLED=true.
 * Routes use the exact same path suffixes as the real Zillow API.
 */
function setupZillowMock(app, config) {
  const zillow = config?.thirdParty?.zillow || config;
  const mockEnabled = !!(zillow && zillow.mockEnabled);

  if (!mockEnabled) {
    app.locals.zillowApiMode = 'live';
    return;
  }

  const mockRouter = createZillowMockRouter({
    expectedApiKey: zillow.mockApiKey || zillow.apiKey,
    expectedFeedId: zillow.feedId,
    callbackUrl: zillow.urls?.callback,
    simulateCallback: zillow.mockSimulateCallback !== false,
    callbackDelayMs: zillow.mockCallbackDelayMs || 500,
    logger,
  });

  // Mount at app root so paths match Zillow exactly: /listing-tools/api/v1/...
  app.use('/', mockRouter);
  app.locals.zillowApiMode = 'mock';

  const catalog = getMockApiCatalog(zillow.apiPublicBaseUrl);
  logger.info('Using mock Zillow API - endpoints match real Zillow path suffixes exactly:');
  catalog.forEach((api) => {
    logger.info(`  [${api.method}] ${api.mockUrl}`);
  });
  if (zillow.mockSimulateCallback !== false) {
    logger.info(`  callback simulation → ${zillow.urls?.callback} (delay ${zillow.mockCallbackDelayMs || 500}ms)`);
  }
  logger.info(`  (${ZILLOW_INTEGRATED_OUTBOUND_APIS.length} outbound Zillow APIs mocked)`);
}

module.exports = { setupZillowMock };
