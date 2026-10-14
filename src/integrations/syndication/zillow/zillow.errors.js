/**
 * ------------------------------------------------------------------
 * File: zillow.errors.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for zillow.errors.
 *
 * Used By:
 * zillowFeedFileService, zillowRealtimeApiClient, ZillowSyndicationProvider, zillowXmlBuilder
 * ------------------------------------------------------------------
 */

/**
 * Base syndication error - all provider-specific errors extend this.
 */
class SyndicationError extends Error {
  constructor(message, { code = 'SYNDICATION_ERROR', provider = 'UNKNOWN', details = null } = {}) {
    super(message);
    this.name = 'SyndicationError';
    this.code = code;
    this.provider = provider;
    this.details = details;
  }
}

/**
 * ZillowValidationError
 *
 * Represents the Zillow Validation Error controller/model class.
 */
class ZillowValidationError extends SyndicationError {
  constructor(message, details = null) {
    super(message, { code: 'ZILLOW_VALIDATION_ERROR', provider: 'ZILLOW', details });
    this.name = 'ZillowValidationError';
  }
}

/**
 * ZillowApiError
 *
 * Represents the Zillow Api Error controller/model class.
 */
class ZillowApiError extends SyndicationError {
  constructor(message, details = null) {
    super(message, { code: 'ZILLOW_API_ERROR', provider: 'ZILLOW', details });
    this.name = 'ZillowApiError';
  }
}

/**
 * ZillowFeedError
 *
 * Represents the Zillow Feed Error controller/model class.
 */
class ZillowFeedError extends SyndicationError {
  constructor(message, details = null) {
    super(message, { code: 'ZILLOW_FEED_ERROR', provider: 'ZILLOW', details });
    this.name = 'ZillowFeedError';
  }
}

/**
 * ZillowFeedGenerationError
 *
 * Represents the Zillow Feed Generation Error controller/model class.
 */
class ZillowFeedGenerationError extends SyndicationError {
  constructor(message, details = null) {
    super(message, { code: 'ZILLOW_FEED_GENERATION_ERROR', provider: 'ZILLOW', details });
    this.name = 'ZillowFeedGenerationError';
  }
}

module.exports = {
  SyndicationError,
  ZillowValidationError,
  ZillowApiError,
  ZillowFeedError,
  ZillowFeedGenerationError,
};
