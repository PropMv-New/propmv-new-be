const crypto = require('crypto');

/**
 * ------------------------------------------------------------------
 * File: webhook.middleware.js
 * Module: Payment Module
 *
 * Purpose:
 * Express middleware providing request timing, rate limiting, logging, or authentication filters.
 *
 * Used By:
 * webhook.routes
 * ------------------------------------------------------------------
 */
const logger = require('../../../../common/logger');

/**
 * Verifies the Straddle webhook signature (CWE-352 countermeasure).
 * Straddle signs payloads with HMAC-SHA256 using the webhook secret.
 * Header: straddle-signature: sha256=<hex_digest>
 */
const verifyStraddleSignature = (req, res, next) => {
  const secret = process.env.STRADDLE_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('[Webhook] STRADDLE_WEBHOOK_SECRET not configured - skipping signature check');
    return next();
  }

  const signature = req.headers['straddle-signature'] || '';
  const rawBody = req.body && req.rawBody ? req.rawBody : JSON.stringify(req.body);

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    logger.warn('[Webhook] Invalid Straddle signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  next();
};

const validateWebhookPayload = (req, res, next) => {
  const { event_id, event_type, data } = req.body;

  if (!event_id) {
    logger.warn('[Webhook] Missing event_id');
    return res.status(400).json({ error: 'Missing event_id' });
  }

  if (!event_type) {
    logger.warn('[Webhook] Missing event_type');
    return res.status(400).json({ error: 'Missing event_type' });
  }

  if (!data || typeof data !== 'object') {
    logger.warn('[Webhook] Missing or invalid data object');
    return res.status(400).json({ error: 'Missing or invalid data object' });
  }

  if (!data.id) {
    logger.warn('[Webhook] Missing data.id');
    return res.status(400).json({ error: 'Missing payout id in data' });
  }

  if (!data.status) {
    logger.warn('[Webhook] Missing data.status');
    return res.status(400).json({ error: 'Missing status in data' });
  }

  next();
};

module.exports = { validateWebhookPayload, verifyStraddleSignature };
