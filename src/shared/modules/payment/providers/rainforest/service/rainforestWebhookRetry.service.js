'use strict';

const RainforestWebhookEvent = require('../model/rainforestWebhookEvent.model');
const { processRainforestWebhookEvent } = require('./rainforestWebhook.service');
const { ensureRainforestEnabled } = require('./rainforestMerchant.service');
const {
  buildRetryableWebhookQuery,
  DEFAULT_MAX_WEBHOOK_RETRIES,
} = require('../utils/rainforestWebhookRetry.util');
const logger = require('../../../../../../common/logger');

async function retryFailedRainforestWebhooks({
  batchSize = 25,
  maxRetries = DEFAULT_MAX_WEBHOOK_RETRIES,
} = {}) {
  ensureRainforestEnabled();

  const { query, limit } = buildRetryableWebhookQuery({ maxRetries, limit: batchSize });
  const events = await RainforestWebhookEvent.find(query)
    .sort({ updatedAt: 1 })
    .limit(limit);

  let attempted = 0;
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  for (const doc of events) {
    attempted += 1;
    try {
      const result = await processRainforestWebhookEvent(doc);
      if (result?.skipped) {
        skipped += 1;
      } else if (result?.processed) {
        processed += 1;
      }
      results.push({
        eventId: doc.eventId,
        eventType: doc.eventType,
        status: 'processed',
        result,
      });
    } catch (err) {
      failed += 1;
      results.push({
        eventId: doc.eventId,
        eventType: doc.eventType,
        status: 'failed',
        error: err.message || 'Retry failed',
      });
    }
  }

  if (attempted > 0) {
    logger.info('[RainforestWebhookRetry] Batch complete', {
      attempted,
      processed,
      failed,
      skipped,
    });
  }

  return {
    attempted,
    processed,
    failed,
    skipped,
    results,
  };
}

module.exports = {
  retryFailedRainforestWebhooks,
};
