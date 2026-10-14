const mongoose = require('mongoose');

/**
 * Permanent bounce / undeliverable recipient suppression list.
 * Prevents re-sending to addresses that previously returned permanent SMTP failures.
 */
const EmailSuppressionSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    reason: { type: String, default: 'permanent_bounce' },
    smtpResponse: { type: String, default: '' },
    bounceReason: { type: String, default: '' },
    source: { type: String, default: 'smtp' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    suppressedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

EmailSuppressionSchema.index({ suppressedAt: -1 });

module.exports =
  mongoose.models.EmailSuppression ||
  mongoose.model('EmailSuppression', EmailSuppressionSchema);
