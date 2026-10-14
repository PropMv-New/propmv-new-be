'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controller/payload.controller');
const {
  jsonWithRawBody,
  verifyPayloadSignature,
  validatePayloadWebhookPayload,
  rateLimitPayloadWebhook,
} = require('../middleware/payloadWebhook.middleware');

router.post(
  '/',
  rateLimitPayloadWebhook,
  jsonWithRawBody,
  verifyPayloadSignature,
  validatePayloadWebhookPayload,
  controller.handlePayloadWebhook,
);

module.exports = router;
