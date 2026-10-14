/**
 * ------------------------------------------------------------------
 * File: markForUpdate.mock.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for markForUpdate.mock.
 *
 * Used By:
 * zillowMockApi
 * ------------------------------------------------------------------
 */

/**
 * Mock handler for Zillow Real-Time Listing API markForUpdate.
 * Path: GET /listing-tools/api/v1/externalListing/markForUpdate
 * Query: apikey, feedId, feedListingIds
 * Response: XML with <succes> (Zillow typo) and <queued>
 */
const axios = require('axios');
const mockState = require('../zillowMockState');
const { validateHotPadsFeedXml } = require('../hotPadsXmlValidator');

/**
 * build Mark For Update Xml
 *
 * Performs logic operations for buildMarkForUpdateXml.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function buildMarkForUpdateXml({ success, queued }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<response>',
    `<succes>${success ? 'true' : 'false'}</succes>`,
    `<queued>${queued}</queued>`,
    '</response>',
  ].join('');
}

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
 * create Mark For Update Handler
 *
 * Performs logic operations for createMarkForUpdateHandler.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function createMarkForUpdateHandler(options = {}) {
  const {
    expectedApiKey = 'mock-zillow-api-key',
    expectedFeedId = 'mock-feed-id',
    callbackUrl = '',
    simulateCallback = true,
    callbackDelayMs = 500,
    logger = console,
  } = options;

  return async function handleMarkForUpdate(req, res) {
    const apiKey = req.query.apikey || req.query.apiKey;
    const feedId = req.query.feedId;
    const feedListingIds = parseFeedListingIdsParam(req.query.feedListingIds);

    if (!apiKey || apiKey !== expectedApiKey) {
      res.set('Content-Type', 'application/xml; charset=utf-8');
      return res.status(401).send(buildMarkForUpdateXml({ success: false, queued: 0 }));
    }

    if (!feedId) {
      res.set('Content-Type', 'application/xml; charset=utf-8');
      return res.status(400).send(buildMarkForUpdateXml({ success: false, queued: 0 }));
    }

    if (expectedFeedId && feedId !== expectedFeedId) {
      res.set('Content-Type', 'application/xml; charset=utf-8');
      return res.status(403).send(buildMarkForUpdateXml({ success: false, queued: 0 }));
    }

    if (!feedListingIds.length) {
      res.set('Content-Type', 'application/xml; charset=utf-8');
      return res.status(400).send(buildMarkForUpdateXml({ success: false, queued: 0 }));
    }

    const queuedIds = mockState.markForUpdate({ feedListingIds, feedId, action: 'update' });

    if (simulateCallback && callbackUrl) {
      const idsParam = queuedIds.join(',');
      setTimeout(() => {
        axios.get(callbackUrl, {
          params: { feedListingIds: idsParam },
          timeout: 15000,
          validateStatus: () => true,
        })
          .then((response) => {
            if (response.status >= 200 && response.status < 300) {
              const xmlBody = typeof response.data === 'string' ? response.data : '';
              const validation = validateHotPadsFeedXml(xmlBody);
              mockState.markCallbackFetched(queuedIds, {
                callbackXmlValid: validation.valid,
                callbackXmlErrors: validation.errors,
                callbackXmlLength: xmlBody.length,
              });
              logger.info?.('Mock Zillow callback simulated', {
                feedListingIds: idsParam,
                status: response.status,
                hotPadsFormatValid: validation.valid,
              });
            } else {
              logger.warn?.('Mock Zillow callback returned non-success', {
                feedListingIds: idsParam,
                status: response.status,
              });
            }
          })
          .catch((err) => {
            logger.warn?.('Mock Zillow callback simulation failed', {
              feedListingIds: idsParam,
              error: err.message,
            });
          });
      }, callbackDelayMs);
    }

    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(buildMarkForUpdateXml({ success: true, queued: queuedIds.length }));
  };
}

module.exports = {
  buildMarkForUpdateXml,
  createMarkForUpdateHandler,
};
