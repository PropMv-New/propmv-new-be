'use strict';

const logger = require('../common/logger');
const rainforestConfig = require('../config/rainforest.config');

let retryTimer = null;
let isRetryRunning = false;

const RETRY_INTERVAL_MS = Number(process.env.RAINFOREST_WEBHOOK_RETRY_INTERVAL_MS) || 5 * 60 * 1000;
const STARTUP_DELAY_MS = Number(process.env.RAINFOREST_OPS_STARTUP_DELAY_MS) || 30_000;
const RETRY_BATCH_SIZE = Number(process.env.RAINFOREST_WEBHOOK_RETRY_BATCH_SIZE) || 25;

async function runRainforestWebhookRetryJob() {
  if (isRetryRunning) {
    logger.warn('[RainforestOpsCron] Webhook retry skipped - previous run in progress');
    return;
  }

  if (!rainforestConfig.rainforest.enabled) {
    return;
  }

  isRetryRunning = true;
  try {
    const { retryFailedRainforestWebhooks } = require('../shared/modules/payment/providers/rainforest/service/rainforestWebhookRetry.service');
    await retryFailedRainforestWebhooks({ batchSize: RETRY_BATCH_SIZE });
  } catch (err) {
    logger.error('[RainforestOpsCron] Webhook retry job failed', { error: err.message });
  } finally {
    isRetryRunning = false;
    scheduleNextWebhookRetry();
  }
}

function scheduleNextWebhookRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(runRainforestWebhookRetryJob, RETRY_INTERVAL_MS);
}

function startRainforestOperationsCronJob() {
  if ((process.env.RAINFOREST_OPS_CRON_ENABLED || 'true').toLowerCase() !== 'true') {
    logger.info('[RainforestOpsCron] Disabled via RAINFOREST_OPS_CRON_ENABLED=false');
    return;
  }

  if (!rainforestConfig.rainforest.enabled) {
    logger.info('[RainforestOpsCron] Skipped - Rainforest disabled');
    return;
  }

  setTimeout(() => {
    scheduleNextWebhookRetry();
    logger.info('[RainforestOpsCron] Initialized', {
      retryIntervalMs: RETRY_INTERVAL_MS,
      retryBatchSize: RETRY_BATCH_SIZE,
    });
  }, STARTUP_DELAY_MS);
}

module.exports = {
  startRainforestOperationsCronJob,
  runRainforestWebhookRetryJob,
};
