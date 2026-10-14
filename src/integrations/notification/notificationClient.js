/**
 * ------------------------------------------------------------------
 * File: notificationClient.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for notificationClient.
 *
 * Used By:
 * notification, notify
 * ------------------------------------------------------------------
 */

/**
 * Notification Client - propmv backend
 *
 * Strategy (all RabbitMQ logic lives inside the notification service):
 *
 *   1. POST /api/notifications  (notification service REST)
 *      - The notification service tries RabbitMQ first.
 *      - If RabbitMQ is down it saves the record with pendingDelivery=true
 *        and its own reprocessing worker retries delivery every 30 s.
 *      - Either way the notification is persisted and never lost.
 *
 *   2. If the notification service itself is unreachable (network error / service down)
 *      we retry up to MAX_RETRIES times with exponential back-off, then log and
 *      return { success: false } - the caller (notify.js) never throws.
 *
 * This means the propmv backend needs NO direct MongoDB connection and NO
 * RabbitMQ channel of its own for notifications.
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../common/logger');

const getServiceUrl = () => process.env.NOTIFICATION_SERVICE_URL;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 300;

// Warn once at startup if the notification service URL is not configured
setImmediate(() => {
  const url = getServiceUrl();
  if (!url) {
    logger.warn(
      'NOTIFICATION_SERVICE_URL is not set - in-app notifications will be silently skipped. ' +
      'Set NOTIFICATION_SERVICE_URL and NOTIFICATION_SERVICE_API_KEY in your .env file.'
    );
  } else {
    logger.info(`Notification service configured at: ${url}`);
  }
});

// ── HTTP client pointed at the notification service ───────────────────────────
const http = axios.create({
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' },
});

// Inject baseURL and service key dynamically so they are always read after dotenv has loaded
http.interceptors.request.use((config) => {
  config.baseURL = getServiceUrl();
  config.headers['x-service-key'] = process.env.NOTIFICATION_SERVICE_API_KEY || '';
  return config;
});

// ── Retry helper with exponential back-off ────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const postWithRetry = async (path, body, attempt = 1) => {
  try {
    const { data } = await http.post(path, body);
    return data;
  } catch (err) {
    const isNetworkError = !err.response; // no response = service unreachable
    if (isNetworkError && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `Notification service unreachable - retry ${attempt}/${MAX_RETRIES} in ${delay}ms`,
        { err: err.message }
      );
      await sleep(delay);
      return postWithRetry(path, body, attempt + 1);
    }
    throw err;
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a single notification.
 * The notification service handles RabbitMQ → fallback internally.
 * If the service is unreachable after retries we log and return { success: false }.
 */
const sendNotification = async (payload) => {
  const serviceUrl = getServiceUrl();
  if (!serviceUrl) {
    logger.warn('Skipping notification - NOTIFICATION_SERVICE_URL not configured', {
      userId: payload.userId,
      type: payload.type,
    });
    return { success: false, error: 'NOTIFICATION_SERVICE_URL not configured' };
  }

  const notificationId = payload.notificationId || crypto.randomUUID();

  const body = {
    notificationId,
    userId: payload.userId,
    title: payload.title,
    message: payload.message,
    type: payload.type,
    priority: payload.priority || 'medium',
    metadata: payload.metadata || {},
  };

  logger.info('Sending notification to service', { userId: body.userId, type: body.type, url: getServiceUrl() });

  try {
    const result = await postWithRetry('/api/notifications', body);
    logger.info('Notification accepted by service', {
      userId: body.userId,
      type: body.type,
      via: result.via || 'service',
      status: result.success,
    });
    return { success: true, notificationId, method: result.via || 'service' };
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;
    logger.error('Failed to deliver notification after retries', {
      userId: body.userId,
      type: body.type,
      status,
      err: message,
    });
    return { success: false, notificationId, error: message };
  }
};

/**
 * initialize() - kept for backward compatibility.
 * No connections to set up; the notification service owns all infrastructure.
 */
const initialize = async () => {
  const url = getServiceUrl();
  if (!url) {
    logger.warn('Notification service URL not configured - in-app notifications disabled');
    return;
  }
  logger.info(`Notification client ready - service: ${url}`);
};

module.exports = { initialize, sendNotification };
