'use strict';

const logger = require('../../../../../../common/logger');
const rainforestConfig = require('../../../../../../config/rainforest.config');
const { verifyRainforestWebhookSignature } = require('../utils/rainforestWebhookSignature.util');

const jsonWithRawBody = expressJsonWithRawBody();

function expressJsonWithRawBody() {
  const express = require('express');
  return express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  });
}

function verifyRainforestSignature(req, res, next) {
  const secret = rainforestConfig.rainforest.webhookSecret;
  if (!secret) {
    logger.warn('[RainforestWebhook] RAINFOREST_WEBHOOK_SECRET not configured - rejecting webhook');
    return res.status(503).json({ message: 'Rainforest webhook verification is not configured.' });
  }

  const result = verifyRainforestWebhookSignature({
    req,
    secret,
    rawBody: req.rawBody,
  });

  if (!result.valid) {
    logger.warn('[RainforestWebhook] Invalid signature', { reason: result.reason });
    return res.status(401).json({ message: 'Invalid Rainforest webhook signature.' });
  }

  req.rainforestSignatureVerified = true;
  return next();
}

function validateRainforestWebhookPayload(req, res, next) {
  const eventType = req.body?.event_type;
  const data = req.body?.data;

  if (!eventType) {
    return res.status(400).json({ message: 'Missing event_type.' });
  }
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ message: 'Missing data payload.' });
  }

  return next();
}

module.exports = {
  jsonWithRawBody,
  verifyRainforestSignature,
  validateRainforestWebhookPayload,
};
