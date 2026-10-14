'use strict';

const mongoose = require('mongoose');
const {
  PAYMENT_PROVIDER,
  WEBHOOK_PROCESSING_STATUS,
} = require('../constants/payload.constants');

const payloadWebhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, default: PAYMENT_PROVIDER.PAYLOAD, index: true },
    eventId: { type: String, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    resourceId: { type: String, default: null, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    signatureVerified: { type: Boolean, default: false },
    processingStatus: {
      type: String,
      enum: Object.values(WEBHOOK_PROCESSING_STATUS),
      default: WEBHOOK_PROCESSING_STATUS.RECEIVED,
      index: true,
    },
    receivedAt: { type: Date, default: Date.now, index: true },
    processedAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0 },
    error: { type: String, default: '' },
  },
  { timestamps: true, collection: 'payloadwebhookevents' }
);

payloadWebhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.models.PayloadWebhookEvent
  || mongoose.model('PayloadWebhookEvent', payloadWebhookEventSchema);
