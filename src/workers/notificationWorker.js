/**
 * ------------------------------------------------------------------
 * File: notificationWorker.js
 * Module: Src Workers
 *
 * Purpose:
 * Backend utility/module providing helper functions for notificationWorker.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

require('../config/loadEnv');
const axios = require('axios');
const logger = require('../common/logger');

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL;
const NOTIFICATION_SERVICE_API_KEY = process.env.NOTIFICATION_SERVICE_API_KEY;
const WORKER_INTERVAL = 60000; // 1 minute

// ── HTTP client for the notification service REST API ─────────────────────────
const http = axios.create({
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  config.baseURL = NOTIFICATION_SERVICE_URL;
  config.headers['x-service-key'] = NOTIFICATION_SERVICE_API_KEY || '';
  return config;
});

/**
 * Reprocess pending notifications by re-sending them to the notification service.
 * The notification service will try RabbitMQ first; if RabbitMQ is down it will
 * save with pendingDelivery=true and deliver via SSE directly - so notifications
 * are never lost regardless of RabbitMQ state.
 */
const reprocessPendingNotifications = async () => {
  if (!NOTIFICATION_SERVICE_URL) {
    logger.warn('NOTIFICATION_SERVICE_URL not set - skipping worker reprocess');
    return 0;
  }

  try {
    const { data } = await http.post('/api/notifications/reprocess-pending');
    const count = data?.data?.reprocessed ?? 0;
    if (count > 0) logger.info(`Worker reprocessed ${count} pending notifications`);
    return count;
  } catch (err) {
    logger.warn('Worker: failed to trigger reprocess on notification service', { err: err.message });
    return 0;
  }
};

const startWorker = async () => {
  logger.info('Starting notification worker...');

  if (!NOTIFICATION_SERVICE_URL) {
    logger.warn('NOTIFICATION_SERVICE_URL not configured - notification worker disabled');
    return;
  }

  // Run immediately
  await reprocessPendingNotifications();

  // Then run every minute
  setInterval(async () => {
    await reprocessPendingNotifications();
  }, WORKER_INTERVAL);

  logger.info(`Worker running, checking every ${WORKER_INTERVAL / 1000} seconds`);
};

process.on('SIGINT', () => { logger.info('Shutting down worker...'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('Shutting down worker...'); process.exit(0); });

startWorker().catch(err => {
  logger.error('Failed to start worker', { err: err.message });
  process.exit(1);
});
