/**
 * ------------------------------------------------------------------
 * File: ListingSyndicationProvider.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for ListingSyndicationProvider.
 *
 * Used By:
 * SyndicationProviderFactory, ZillowSyndicationProvider
 * ------------------------------------------------------------------
 */

/**
 * Abstract base class for listing syndication providers.
 * Each third-party channel (Zillow, Apartments.com, etc.) extends this contract.
 */
class ListingSyndicationProvider {
  constructor({ logger, httpClient, config } = {}) {
    if (new.target === ListingSyndicationProvider) {
      throw new Error('ListingSyndicationProvider is abstract and cannot be instantiated directly');
    }
    this.logger = logger;
    this.httpClient = httpClient;
    this.config = config;
  }

  /** @returns {string} Provider identifier, e.g. ZILLOW */
  getProviderName() {
    throw new Error('getProviderName() must be implemented');
  }

  /**
   * Validates listing has minimum fields required by this provider.
   * @throws {import('./zillow/zillow.errors').ZillowValidationError}
   */
  async validateListing(/* listing */) {
    throw new Error('validateListing() must be implemented');
  }

  /** Maps internal listing document to provider payload (XML fragment, JSON, etc.) */
  async mapListingToProviderFormat(/* listing */) {
    throw new Error('mapListingToProviderFormat() must be implemented');
  }

  /** Pushes or updates listing on the provider */
  async createOrUpdateListing(/* listing */) {
    throw new Error('createOrUpdateListing() must be implemented');
  }

  /** Removes or deactivates listing on the provider */
  async removeListing(/* listing */) {
    throw new Error('removeListing() must be implemented');
  }

  /** Optional: fetch live sync status from provider API */
  async getSyncStatus(/* listing */) {
    return {
      success: true,
      providerName: this.getProviderName(),
      status: 'UNKNOWN',
      message: 'getSyncStatus not implemented for this provider',
    };
  }
}

module.exports = ListingSyndicationProvider;
