/**
 * ------------------------------------------------------------------
 * File: feedReport.mock.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for feedReport.mock.
 *
 * Used By:
 * zillowMockApi
 * ------------------------------------------------------------------
 */

/**
 * Mock handler for Zillow feed run report API.
 * Mimics: GET https://feeds.hotpads.com/report/[feedId]/latest.txt
 * Mock path: GET /report/:feedId/latest.txt
 *
 * Serves the local latest.txt file from public/feeds/zillow/.
 */
const fs = require('fs').promises;
const path = require('path');

/**
 * create Feed Report Handler
 *
 * Performs logic operations for createFeedReportHandler.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function createFeedReportHandler(options = {}) {
  const { localReportPath, logger = console } = options;

  return async function handleFeedReport(req, res) {
    const { feedId } = req.params;

    try {
      const reportText = await fs.readFile(localReportPath, 'utf8');
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(reportText);
    } catch (error) {
      logger.warn?.('Mock feed report file not found', {
        feedId,
        localReportPath,
        error: error.message,
      });
      return res.status(404).send(`Feed report not found for feedId: ${feedId}`);
    }
  };
}

module.exports = { createFeedReportHandler };
