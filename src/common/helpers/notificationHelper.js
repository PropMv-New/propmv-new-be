const axios = require('axios');
const logger = require('../logger');

const getServiceUrl = () => process.env.NOTIFICATION_SERVICE_URL || '';
const getServiceApiKey = () =>
  process.env.NOTIFICATION_SERVICE_API_KEY || process.env.SERVICE_API_KEY || '';

/**
 * Send a single notification to the notification service.
 * Fire-and-forget - never throws so callers are not disrupted.
 */
async function sendNotification({ userId, title, message, type = 'info', priority = 'medium', metadata = {} }) {
  if (!userId || !title || !message) return;

  const serviceUrl = getServiceUrl();
  const apiKey = getServiceApiKey();
  if (!serviceUrl || !apiKey) {
    if (logger && logger.warn) {
      logger.warn('sendNotification skipped - NOTIFICATION_SERVICE_URL or API key not configured', {
        userId: String(userId),
        type,
      });
    }
    return;
  }

  try {
    await axios.post(
      `${serviceUrl.replace(/\/$/, '')}/api/notifications`,
      { userId: String(userId), title, message, type, priority, metadata },
      {
        headers: { 'x-service-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 5000,
      }
    );
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn('sendNotification failed', { userId: String(userId), type, err: err.message });
    }
  }
}

/**
 * Send the same notification to multiple users.
 */
async function sendNotificationToMany(userIds, payload) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;
  await Promise.all(userIds.map((uid) => sendNotification({ ...payload, userId: uid })));
}

module.exports = { sendNotification, sendNotificationToMany };
