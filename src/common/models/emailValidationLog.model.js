const mongoose = require('mongoose');

/**
 * Audit log for pre-send email / domain validation decisions.
 *
 * ACCESS CONTROL: This collection contains normalised email addresses and
 * validation metadata. Queries must be restricted to admin/ops roles only.
 * Do NOT expose this collection via any tenant- or landlord-scoped API route.
 */
const EmailValidationLogSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    normalizedEmail: { type: String, required: true, index: true },
    syntaxValid: { type: Boolean, required: true },
    domain: { type: String, default: '' },
    mxValid: { type: Boolean, default: null },
    mxRecords: { type: [String], default: undefined },
    suppressed: { type: Boolean, default: false },
    result: {
      type: String,
      enum: [
        'pass',
        'fail_syntax',
        'fail_mx',
        'fail_mailbox',
        'fail_suppressed',
        'fail_other',
      ],
      required: true,
    },
    mailboxStatus: { type: String, default: '' },
    bounceReason: { type: String, default: '' },
    smtpResponse: { type: String, default: '' },
    message: { type: String, default: '' },
    context: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

EmailValidationLogSchema.index({ createdAt: -1 });
EmailValidationLogSchema.index({ result: 1, createdAt: -1 });

module.exports =
  mongoose.models.EmailValidationLog ||
  mongoose.model('EmailValidationLog', EmailValidationLogSchema);
