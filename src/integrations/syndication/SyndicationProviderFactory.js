/**
 * ------------------------------------------------------------------
 * File: SyndicationProviderFactory.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for SyndicationProviderFactory.
 *
 * Used By:
 * syndication.service
 * ------------------------------------------------------------------
 */

const ListingSyndicationProvider = require('./ListingSyndicationProvider');
const { SYNDICATION_PROVIDERS } = require('./syndication.constants');
const ZillowSyndicationProvider = require('./zillow/ZillowSyndicationProvider');
const logger = require('../../common/logger');
const axios = require('axios');
const zillowConfig = require('./zillow/zillow.config');

/**
 * Factory for syndication provider instances.
 * Listing flow code must use syndicationService - never this factory directly.
 */
class SyndicationProviderFactory {
  /**
   * @param {string} providerName - One of SYNDICATION_PROVIDERS values
   * @param {object} [deps] - Optional injected dependencies for testing
   * @returns {ListingSyndicationProvider}
   */
  static getProvider(providerName, deps = {}) {
    const normalized = String(providerName || '').toUpperCase();

    switch (normalized) {
      case SYNDICATION_PROVIDERS.ZILLOW:
        return new ZillowSyndicationProvider({
          logger: deps.logger || logger,
          httpClient: deps.httpClient || axios,
          config: deps.config || zillowConfig,
          feedFileService: deps.feedFileService,
          realtimeApiClient: deps.realtimeApiClient,
          xmlBuilder: deps.xmlBuilder,
        });
      case SYNDICATION_PROVIDERS.APARTMENTS_COM:
      case SYNDICATION_PROVIDERS.REALTOR_COM:
        // TODO: extend for additional providers
        throw new Error(`Provider ${normalized} is not yet implemented`);
      default:
        throw new Error(`Unknown syndication provider: ${providerName}`);
    }
  }

  static getSupportedProviders() {
    return [SYNDICATION_PROVIDERS.ZILLOW];
  }
}

module.exports = SyndicationProviderFactory;
