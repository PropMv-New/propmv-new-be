/**
 * ------------------------------------------------------------------
 * File: webhook.routes.js
 * Module: Payment Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const { handlePaymentStatusWebhook, handleAccountCreateWebhook, handleAccountEventWebhook, handleCapabilityRequestWebhook, handleCapabilityEventWebhook, handleChargeCreateWebhook, handleChargeEventWebhook, handleCustomerCreateWebhook, handleCustomerEventWebhook, handleFundingEventCreateWebhook, handleFundingEventEventWebhook, handleLinkedBankAccountCreateWebhook, handleLinkedBankAccountEventWebhook, handlePaykeyCreateWebhook, handlePaykeyEventWebhook, handlePayoutCreateWebhook, handlePayoutEventWebhook, handleRepresentativeCreateWebhook, handleRepresentativeEventWebhook } = require('../controller/webhook.controller');
const { validateWebhookPayload, verifyStraddleSignature } = require('../middleware/webhook.middleware');

// Capture raw body for HMAC signature verification, then parse JSON
const jsonWithRawBody = express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
});

// All Straddle webhook routes: verify signature first, then validate shape
router.post('/straddle/payment-event', jsonWithRawBody, verifyStraddleSignature, validateWebhookPayload, handlePaymentStatusWebhook);
router.post('/straddle/account-create', jsonWithRawBody, verifyStraddleSignature, handleAccountCreateWebhook);
router.post('/straddle/account-event', jsonWithRawBody, verifyStraddleSignature, handleAccountEventWebhook);
router.post('/straddle/capability-request', jsonWithRawBody, verifyStraddleSignature, handleCapabilityRequestWebhook);
router.post('/straddle/capability-event', jsonWithRawBody, verifyStraddleSignature, handleCapabilityEventWebhook);
router.post('/straddle/charge-create', jsonWithRawBody, verifyStraddleSignature, handleChargeCreateWebhook);
router.post('/straddle/charge-event', jsonWithRawBody, verifyStraddleSignature, handleChargeEventWebhook);
router.post('/straddle/customer-create', jsonWithRawBody, verifyStraddleSignature, handleCustomerCreateWebhook);
router.post('/straddle/customer-event', jsonWithRawBody, verifyStraddleSignature, handleCustomerEventWebhook);
router.post('/straddle/funding-event-create', jsonWithRawBody, verifyStraddleSignature, handleFundingEventCreateWebhook);
router.post('/straddle/funding-event-event', jsonWithRawBody, verifyStraddleSignature, handleFundingEventEventWebhook);
router.post('/straddle/linked-bank-account-create', jsonWithRawBody, verifyStraddleSignature, handleLinkedBankAccountCreateWebhook);
router.post('/straddle/linked-bank-account-event', jsonWithRawBody, verifyStraddleSignature, handleLinkedBankAccountEventWebhook);
router.post('/straddle/paykey-create', jsonWithRawBody, verifyStraddleSignature, handlePaykeyCreateWebhook);
router.post('/straddle/paykey-event', jsonWithRawBody, verifyStraddleSignature, handlePaykeyEventWebhook);
router.post('/straddle/payout-create', jsonWithRawBody, verifyStraddleSignature, handlePayoutCreateWebhook);
router.post('/straddle/payout-event', jsonWithRawBody, verifyStraddleSignature, handlePayoutEventWebhook);
router.post('/straddle/representative-create', jsonWithRawBody, verifyStraddleSignature, handleRepresentativeCreateWebhook);
router.post('/straddle/representative-event', jsonWithRawBody, verifyStraddleSignature, handleRepresentativeEventWebhook);

module.exports = router;
