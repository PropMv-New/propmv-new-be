'use strict';

const logger = require('../../../../../../common/logger');

const jsonWithRawBody = expressJsonWithRawBody();

function expressJsonWithRawBody() {
  const express = require('express');
  return express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  });
}

/**
 * Payload v2 Orchestrate webhooks (public docs) POST JSON with trigger + triggered_on.
 * There is no documented Rainforest-style shared signing secret on inbound requests.
 * PropMv treats webhooks as hints and re-fetches the transaction/processing account via API
 * before mutating invoices (see payloadWebhook.service.js).
 *
 * Hardening:
 * - Never settle from body alone (enforced in webhook service via re-fetch).
 * - Forbidden: secrets in query-string URLs (reject if query carries secret-like keys).
 * - Optional shared bearer: set PAYLOAD_WEBHOOK_BEARER; Authorization: Bearer <token> required when set.
 * - Reject empty/malformed triggers.
 */
function verifyPayloadSignature(req, res, next) {
  if (process.env.PAYLOAD_WEBHOOK_SECRET) {
    logger.warn(
      '[PayloadWebhook] PAYLOAD_WEBHOOK_SECRET is set but Payload does not document inbound HMAC signing for v2 - ignoring. Remove this variable from .env until Payload publishes a signing mechanism.'
    );
  }

  // Forbid secrets in query string (hard gate from roadmap)
  const q = req.query || {};
  const forbiddenQueryKeys = ['secret', 'token', 'webhook_secret', 'api_key', 'apikey', 'key'];
  for (const key of Object.keys(q)) {
    if (forbiddenQueryKeys.includes(String(key).toLowerCase())) {
      logger.warn('[PayloadWebhook] Rejected webhook with secret-like query parameter', {
        key: String(key).slice(0, 32),
      });
      return res.status(400).json({ message: 'Webhook query authentication is not supported.' });
    }
  }

  const expectedBearer = String(process.env.PAYLOAD_WEBHOOK_BEARER || '').trim();
  if (expectedBearer) {
    const auth = String(req.headers.authorization || '');
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const presented = match ? String(match[1] || '').trim() : '';
    if (!presented || presented !== expectedBearer) {
      return res.status(401).json({ message: 'Unauthorized webhook.' });
    }
    req.payloadSignatureVerified = true;
    return next();
  }

  req.payloadSignatureVerified = false;
  return next();
}

function validatePayloadWebhookPayload(req, res, next) {
  const trigger = req.body?.trigger || req.body?.event_type;
  const triggeredOn = req.body?.triggered_on;
  const data = req.body?.data;

  if (!trigger || typeof trigger !== 'string' || !String(trigger).trim()) {
    return res.status(400).json({ message: 'Missing webhook trigger.' });
  }
  if (!triggeredOn && (!data || typeof data !== 'object')) {
    return res.status(400).json({ message: 'Missing triggered_on or data payload.' });
  }

  return next();
}

/** Lightweight rate limit for webhook route (per IP). */
const webhookRateBuckets = new Map();
function rateLimitPayloadWebhook(req, res, next) {
  const ip = String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || 'unknown',
  );
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 120;
  let bucket = webhookRateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > windowMs) {
    bucket = { windowStart: now, count: 0 };
    webhookRateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return res.status(429).json({ message: 'Too many webhook requests.' });
  }
  return next();
}

module.exports = {
  jsonWithRawBody,
  verifyPayloadSignature,
  validatePayloadWebhookPayload,
  rateLimitPayloadWebhook,
};
