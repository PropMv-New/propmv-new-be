const mongoose = require('mongoose');

/**
 * Tracks IMAP bounce messages already processed so lookback rescans are idempotent.
 */
const EmailBounceProcessedSchema = new mongoose.Schema(
  {
    providerKey: { type: String, required: true, index: true },
    messageUid: { type: String, required: true },
    messageId: { type: String, default: '', index: true },
    recipientEmail: { type: String, default: '', index: true },
    subject: { type: String, default: '' },
    suppressed: { type: Boolean, default: false },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

EmailBounceProcessedSchema.index({ providerKey: 1, messageUid: 1 }, { unique: true });
EmailBounceProcessedSchema.index({ processedAt: -1 });

module.exports =
  mongoose.models.EmailBounceProcessed ||
  mongoose.model('EmailBounceProcessed', EmailBounceProcessedSchema);
