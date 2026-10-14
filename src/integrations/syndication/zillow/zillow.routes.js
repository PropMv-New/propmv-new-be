/**
 * ------------------------------------------------------------------
 * File: zillow.routes.js
 * Module: Backend Integrations
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const zillowConfig = require('./zillow.config');
const ZillowFeedFileService = require('./zillowFeedFileService');
const ZillowFeedReportService = require('./zillowFeedReportService');
const { buildEmptyFeedXml } = require('./zillowXmlBuilder');
const logger = require('../../../common/logger');
const authMiddleware = require('../../../middleware/auth');
const authorize = require('../../../middleware/authorize');
const csrfProtection = require('../../../middleware/csrfProtection');

const feedFileService = new ZillowFeedFileService({ config: zillowConfig, logger });
const feedReportService = new ZillowFeedReportService({ config: zillowConfig, logger });
const {
  getMockApiCatalog,
  getMockStateSnapshot,
  resetMockState,
} = require('./mock/zillowMockApi');

/**
 * Public Zillow integration config (no secrets) for admin UI / onboarding.
 */
async function getPublicConfig(req, res) {
  return res.status(200).json({
    enabled: zillowConfig.enabled,
    env: zillowConfig.env,
    mockEnabled: zillowConfig.mockEnabled,
    companyId: zillowConfig.companyId,
    feedId: zillowConfig.feedId,
    urls: zillowConfig.urls,
    routes: zillowConfig.routes,
    endpoints: {
      markForUpdate: zillowConfig.endpoints.markForUpdate,
      getStatus: zillowConfig.endpoints.getStatus,
    },
    externalApiPaths: zillowConfig.externalApiPaths,
    integratedOutboundApis: zillowConfig.integratedOutboundApis?.map((api) => ({
      id: api.id,
      method: api.method,
      path: api.path,
      activeUrl: zillowConfig.mockEnabled
        ? `${zillowConfig.apiPublicBaseUrl}${api.path}`
        : (zillowConfig.isProduction ? api.prodUrl : api.testUrl),
    })),
    realtimeEnabled: zillowConfig.realtimeEnabled,
    bulkFeedEnabled: zillowConfig.bulkFeedEnabled,
  });
}

/**
 * Zillow Real-Time API callback - Zillow fetches listing XML for marked IDs.
 * Public endpoint (no auth) - Zillow servers call this URL.
 * Query: feedListingIds (comma-separated)
 */
async function handleZillowCallback(req, res) {
  try {
    const idsParam = req.query.feedListingIds || req.query.feedListingId || '';
    const feedListingIds = String(idsParam)
      .split(',')
      .map((id) => id.trim().replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter(Boolean);

    if (!feedListingIds.length) {
      res.set('Content-Type', 'application/xml; charset=utf-8');
      return res.status(200).send(buildEmptyFeedXml());
    }

    const xml = await feedFileService.buildCallbackXmlForIds(feedListingIds);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (error) {
    logger.error('Zillow callback handler failed', {
      provider: 'ZILLOW',
      action: 'callback',
      error: error.message,
    });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(500).send(buildEmptyFeedXml());
  }
}

/**
 * Manual bulk feed regeneration (admin/landlord authenticated).
 */
async function regenerateBulkFeed(req, res) {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    const result = await feedFileService.regenerateFeed({ force });
    return res.status(result.success ? 200 : 409).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

/**
 * Confirm bulk feed after threshold breach.
 */
async function confirmBulkFeed(req, res) {
  try {
    const result = await feedFileService.generateBulkFeedFile({ force: true });
    if (result.success) {
      const processed = await feedFileService.processFeedFileStatuses({ filePath: result.filePath });
      return res.status(200).json({ ...result, processed });
    }
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

const guard = [csrfProtection, authMiddleware, authorize];

router.get('/callback', handleZillowCallback);
router.post('/callback', handleZillowCallback);
router.get('/config', getPublicConfig);
router.post('/bulk-feed/regenerate', ...guard, regenerateBulkFeed);
router.post('/bulk-feed/confirm', ...guard, confirmBulkFeed);

/**
 * Poll the Zillow feed run report and update listing statuses.
 * Accepted → Published, Rejected/Blocked → Publish_Rejected, else → Draft.
 */
router.post('/feed-report/poll', ...guard, async (req, res) => {
  try {
    const result = await feedReportService.pollAndProcess();
    return res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

/** PropMv-only mock debug routes (not part of Zillow's API). */
if (zillowConfig.mockEnabled) {
  router.get('/mock/state', (req, res) => {
    res.json({
      mock: true,
      apis: getMockApiCatalog(zillowConfig.apiPublicBaseUrl),
      listings: getMockStateSnapshot(),
    });
  });
  router.post('/mock/reset', csrfProtection, (req, res) => {
    resetMockState();
    res.json({ success: true, message: 'Mock Zillow state reset' });
  });

  /** Mock API 1: generate bulk feed from Published + Publish_InProgress listings. */
  router.post('/mock/bulk-feed/generate', csrfProtection, async (req, res) => {
    try {
      const force = req.query.force === 'true' || req.body?.force === true;
      const result = await feedFileService.generateBulkFeedFile({ force });
      return res.status(result.success ? 200 : 409).json(result);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  /** Mock API 2: process feed file and finalize listing statuses. */
  router.post('/mock/bulk-feed/process', csrfProtection, async (req, res) => {
    try {
      const filePath = req.body?.filePath;
      const result = await feedFileService.processFeedFileStatuses({ filePath });
      if (!result.success) {
        return res.status(400).json({ message: 'Error', statuscode: 400, data: result });
      }
      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });

  /** Mock API 3: poll Zillow feed report and update listing statuses. */
  router.post('/mock/feed-report/poll', csrfProtection, async (req, res) => {
    try {
      const result = await feedReportService.pollAndProcess();
      return res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  });
}

module.exports = router;
module.exports.handleZillowCallback = handleZillowCallback;
