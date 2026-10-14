/**
 * ------------------------------------------------------------------
 * File: zillowMockApi.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowMockApi.
 *
 * Used By:
 * setupZillowMock, zillow.routes
 * ------------------------------------------------------------------
 */

/**
 * Mock Zillow external API router.
 * Registers a mock handler for every outbound Zillow API integrated by PropMv.
 * Routes use the exact same path suffixes as the real Zillow API (only host differs).
 */
const express = require('express');
const path = require('path');
const {
  ZILLOW_EXTERNAL_API_PATHS,
  ZILLOW_INTEGRATED_OUTBOUND_APIS,
} = require('../zillowApiEndpoints');
const { createMarkForUpdateHandler } = require('./handlers/markForUpdate.mock');
const { createGetStatusHandler } = require('./handlers/getStatus.mock');
const { createFeedReportHandler } = require('./handlers/feedReport.mock');
const mockState = require('./zillowMockState');

const LOCAL_REPORT_PATH = path.join(__dirname, '../../../../../public/feeds/zillow/latest.txt');

/**
 * create Zillow Mock Router
 *
 * Performs logic operations for createZillowMockRouter.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function createZillowMockRouter(options = {}) {
  const router = express.Router();

  router.get(
    ZILLOW_EXTERNAL_API_PATHS.MARK_FOR_UPDATE,
    createMarkForUpdateHandler(options)
  );

  router.get(
    ZILLOW_EXTERNAL_API_PATHS.GET_STATUS,
    createGetStatusHandler()
  );

  // Mock: GET /report/:feedId/latest.txt - mimics https://feeds.hotpads.com/report/[feedId]/latest.txt
  router.get(
    ZILLOW_EXTERNAL_API_PATHS.FEED_REPORT,
    createFeedReportHandler({ localReportPath: LOCAL_REPORT_PATH, logger: options.logger })
  );

  return router;
}

/**
 * get Mock Api Catalog
 *
 * Performs logic operations for getMockApiCatalog.
 *
 * @param publicBaseUrl - Request/input argument
 * @returns Operations result
 */
function getMockApiCatalog(publicBaseUrl) {
  return ZILLOW_INTEGRATED_OUTBOUND_APIS.map((api) => ({
    ...api,
    mockUrl: `${String(publicBaseUrl || '').replace(/\/+$/, '')}${api.path}`,
  }));
}

/**
 * reset Mock State
 *
 * Performs logic operations for resetMockState.
 *
 * @returns Operations result
 */
function resetMockState() {
  mockState.reset();
}

/**
 * get Mock State Snapshot
 *
 * Performs logic operations for getMockStateSnapshot.
 *
 * @returns Operations result
 */
function getMockStateSnapshot() {
  return mockState.snapshot();
}

module.exports = {
  createZillowMockRouter,
  getMockApiCatalog,
  resetMockState,
  getMockStateSnapshot,
  ZILLOW_EXTERNAL_API_PATHS,
  ZILLOW_INTEGRATED_OUTBOUND_APIS,
};
