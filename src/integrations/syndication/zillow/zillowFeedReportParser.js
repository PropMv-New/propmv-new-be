/**
 * ------------------------------------------------------------------
 * File: zillowFeedReportParser.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowFeedReportParser.
 *
 * Used By:
 * zillowFeedReportService
 * ------------------------------------------------------------------
 */

/**
 * Parses the Zillow HotPads feed run report text format.
 * https://feeds.hotpads.com/report/[feedId]/latest.txt
 */

const REPORT_LISTING_STATUS = Object.freeze({
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  BLOCKED: 'Blocked',
});

// Matches: "Accepted listing id=SU00001" or "Rejected listing id=SU00006, reason"
const LISTING_LINE_RE = /^(Accepted|Rejected|Blocked)\s+listing\s+id=([^,\s]+)(?:,\s*(.+))?$/i;

/**
 * Parses the raw report text and returns structured data.
 * @param {string} text
 * @returns {{ feedId: string|null, runTimestamp: string|null, listings: Array<{id: string, status: string, reason: string|null}> }}
 */
function parseFeedReport(text) {
  const lines = String(text || '').split(/\r?\n/);
  const result = {
    feedId: null,
    runTimestamp: null,
    listings: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('Feed ID:')) {
      result.feedId = trimmed.replace('Feed ID:', '').trim();
      continue;
    }

    if (trimmed.startsWith('Run Timestamp:')) {
      result.runTimestamp = trimmed.replace('Run Timestamp:', '').trim();
      continue;
    }

    const match = trimmed.match(LISTING_LINE_RE);
    if (match) {
      result.listings.push({
        id: match[2].trim(),
        status: match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase(),
        reason: match[3] ? match[3].trim() : null,
      });
    }
  }

  return result;
}

module.exports = { parseFeedReport, REPORT_LISTING_STATUS };
