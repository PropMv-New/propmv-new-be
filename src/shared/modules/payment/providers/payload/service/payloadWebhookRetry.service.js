'use strict';

const PayloadWebhookEvent = require('../model/payloadWebhookEvent.model');
const { processPayloadWebhookEvent } = require('./payloadWebhook.service');
const { ensurePayloadEnabled } = require('./payloadMerchant.service');
const {
  buildRetryableWebhookQuery,
  DEFAULT_MAX_WEBHOOK_RETRIES,
} = require('../utils/payloadWebhookRetry.util');
const logger = require('../../../../../../common/logger');

async function retryFailedPayloadWebhooks({
  batchSize = 25,
  maxRetries = DEFAULT_MAX_WEBHOOK_RETRIES,
} = {}) {
  ensurePayloadEnabled();

  const { query, limit } = buildRetryableWebhookQuery({ maxRetries, limit: batchSize });
  const events = await PayloadWebhookEvent.find(query)
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
      const result = await processPayloadWebhookEvent(doc);
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
    logger.info('[PayloadWebhookRetry] Batch complete', {
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
  retryFailedPayloadWebhooks,
};
