'use strict';

const { WEBHOOK_PROCESSING_STATUS } = require('../constants/rainforest.constants');

const DEFAULT_MAX_WEBHOOK_RETRIES = Number(process.env.RAINFOREST_WEBHOOK_RETRY_MAX) || 5;

function shouldRetryWebhookEvent({
  retryCount = 0,
  maxRetries = DEFAULT_MAX_WEBHOOK_RETRIES,
  processingStatus,
} = {}) {
  if (processingStatus !== WEBHOOK_PROCESSING_STATUS.FAILED) return false;
  return Number(retryCount || 0) < Number(maxRetries || DEFAULT_MAX_WEBHOOK_RETRIES);
}

function buildRetryableWebhookQuery({
  maxRetries = DEFAULT_MAX_WEBHOOK_RETRIES,
  limit = 25,
} = {}) {
  return {
    query: {
      processingStatus: WEBHOOK_PROCESSING_STATUS.FAILED,
      retryCount: { $lt: Number(maxRetries || DEFAULT_MAX_WEBHOOK_RETRIES) },
    },
    limit: Math.max(1, Math.min(Number(limit) || 25, 100)),
  };
}

module.exports = {
  DEFAULT_MAX_WEBHOOK_RETRIES,
  shouldRetryWebhookEvent,
  buildRetryableWebhookQuery,
};
