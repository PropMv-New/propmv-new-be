/**
 * ------------------------------------------------------------------
 * File: straddleWebhookEventResponse.model.js
 * Module: Payment Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * seedLeaseInvoicePayments, seedPaymentTransactions, verifyPaymentData, straddlePayment.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const straddleWebhookEventResponseSchema = new mongoose.Schema({
  // A short identifier for the event (use event_id when available)
  // NOTE: not unique so we can store multiple deliveries/retries for the same event
  event: { type: String, required: true, index: true },

  // Account id from the webhook payload - allow indexing by account
  account_id: { type: String, required: false, index: true },

  // Type of the event (from the webhook payload)
  event_type: { type: String, required: false, index: true },

  // Full response payload received from Straddle for this event
  response: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true });

module.exports = mongoose.models.StraddleWebhookEventResponse ||
  mongoose.model('StraddleWebhookEventResponse', straddleWebhookEventResponseSchema);
