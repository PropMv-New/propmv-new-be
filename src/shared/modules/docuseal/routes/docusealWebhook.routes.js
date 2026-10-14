'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../../../../common/logger');
const { getDocusealConfig } = require('../../../../config/docuseal.config');
const docusealController = require('../controller/docuseal.controller');

const jsonWithRawBody = express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
});

/**
 * Optional shared-secret check for DocuSeal webhooks.
 * Configure the same value in DocuSeal Console webhook URL query (?secret=...)
 * or header X-Docuseal-Secret / X-Webhook-Secret.
 */
function verifyDocusealWebhookSecret(req, res, next) {
  const { webhookSecret } = getDocusealConfig();
  if (!webhookSecret) return next();

  const provided =
    req.get('x-docuseal-secret') ||
    req.get('x-webhook-secret') ||
    req.query.secret ||
    req.body?.secret ||
    '';

  if (String(provided) !== String(webhookSecret)) {
    logger.warn('[DocuSeal] webhook secret mismatch');
    return res.status(401).json({
      message: 'Invalid webhook secret',
      statuscode: 401,
      data: null,
    });
  }
  return next();
}

router.post('/', jsonWithRawBody, verifyDocusealWebhookSecret, docusealController.handleWebhook);

module.exports = router;
