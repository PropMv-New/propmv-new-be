'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controller/rainforest.controller');
const {
  jsonWithRawBody,
  verifyRainforestSignature,
  validateRainforestWebhookPayload,
} = require('../middleware/rainforestWebhook.middleware');

router.post('/', jsonWithRawBody, verifyRainforestSignature, validateRainforestWebhookPayload, controller.handleRainforestWebhook);

module.exports = router;
