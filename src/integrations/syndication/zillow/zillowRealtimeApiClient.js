/**
 * ------------------------------------------------------------------
 * File: zillowRealtimeApiClient.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillowRealtimeApiClient.
 *
 * Used By:
 * ZillowSyndicationProvider
 * ------------------------------------------------------------------
 */

const { parseMarkForUpdateResponse } = require('./zillowResponseParser');
const { ZillowApiError } = require('./zillow.errors');

/**
 * HTTP client for Zillow Real-Time Listing API.
 * Handles markForUpdate with exponential backoff retries.
 */
class ZillowRealtimeApiClient {
  constructor({ httpClient, config, logger }) {
    this.httpClient = httpClient;
    this.config = config;
    this.logger = logger;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async requestWithRetry(requestFn) {
    const maxRetries = this.config.http?.maxRetries || 3;
    const baseDelay = this.config.http?.retryBaseDelayMs || 500;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries) break;
        const delay = baseDelay * (2 ** attempt);
        this.logger?.warn('Zillow API retry', {
          provider: 'ZILLOW',
          action: 'markForUpdate',
          attempt: attempt + 1,
          delay,
          error: error.message,
        });
        await this.sleep(delay);
      }
    }

    throw new ZillowApiError(lastError?.message || 'Zillow API request failed', {
      cause: lastError?.message,
      response: lastError?.response?.data,
    });
  }

  /**
   * Marks listings for Zillow to fetch via callback.
   * Query param is "apikey" (lowercase) per Zillow spec.
   */
  async markForUpdate(feedListingIds = []) {
    const ids = Array.isArray(feedListingIds) ? feedListingIds : [feedListingIds];
    const filtered = ids.map((id) => String(id).replace(/[-_]/g, '')).filter(Boolean);

    if (!filtered.length) {
      return { success: false, queued: 0, message: 'No feed listing IDs provided' };
    }

    const params = {
      apikey: this.config.apiKey,
      feedId: this.config.feedId,
      feedListingIds: filtered.join(','),
    };

    const response = await this.requestWithRetry(() =>
      this.httpClient.get(this.config.endpoints.markForUpdate, {
        params,
        timeout: this.config.http?.timeoutMs || 30000,
        responseType: 'text',
        validateStatus: (status) => status < 500,
      })
    );

    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const parsed = parseMarkForUpdateResponse(body);

    if (!parsed.success) {
      throw new ZillowApiError('markForUpdate returned unsuccessful response', { body, parsed });
    }

    return { ...parsed, raw: body };
  }

  /**
   * Returns empty feed XML for listing removals per Zillow removal spec.
   */
  buildRemovalFeedXml() {
    const { buildEmptyFeedXml } = require('./zillowXmlBuilder');
    return buildEmptyFeedXml();
  }
}

module.exports = ZillowRealtimeApiClient;
