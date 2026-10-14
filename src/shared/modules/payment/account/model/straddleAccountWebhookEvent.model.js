'use strict';

const mongoose = require('mongoose');

const straddleAccountWebhookEventSchema = new mongoose.Schema(
  {
    eventId:          { type: String, required: true, unique: true, index: true },
    eventType:        { type: String, required: true, index: true },
    accountId:        { type: String, default: null, index: true },   // Straddle account_id from payload
    straddleAccountId:{ type: String, default: null, index: true },   // our DB record id
    rawPayload:       { type: mongoose.Schema.Types.Mixed, required: true },
    processed:        { type: Boolean, default: false, index: true },
    processedAt:      { type: Date, default: null },
    processingError:  { type: String, default: null },
    retryCount:       { type: Number, default: 0 },
    correlationId:    { type: String, default: null },
  },
  { timestamps: true }
);

straddleAccountWebhookEventSchema.index({ eventType: 1, processed: 1 });
straddleAccountWebhookEventSchema.index({ accountId: 1, eventType: 1 });

module.exports = mongoose.models.StraddleAccountWebhookEvent ||
  mongoose.model('StraddleAccountWebhookEvent', straddleAccountWebhookEventSchema);
