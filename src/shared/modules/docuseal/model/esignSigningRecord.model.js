const mongoose = require('mongoose');

const SUBMITTER_STATUSES = [
  'awaiting',
  'sent',
  'opened',
  'completed',
  'declined',
];

const OVERALL_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'declined',
  'expired',
  'archived',
];

const signerSchema = new mongoose.Schema(
  {
    docusealSubmitterId: { type: Number, index: true },
    uuid: { type: String, default: null },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, default: null },
    role: { type: String, default: null },
    phone: { type: String, default: null },
    status: {
      type: String,
      enum: SUBMITTER_STATUSES,
      default: 'awaiting',
      index: true,
    },
    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    externalId: { type: String, default: null },
  },
  { _id: false }
);

const webhookEventSchema = new mongoose.Schema(
  {
    eventType: { type: String, required: true },
    receivedAt: { type: Date, default: Date.now },
    summary: { type: String, default: null },
  },
  { _id: false }
);

/**
 * Local tracking record for DocuSeal signature requests.
 * Created when a document is sent for signature; updated via DocuSeal webhooks.
 */
const esignSigningRecordSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true, default: null },
    hoaId: { type: mongoose.Schema.Types.ObjectId, ref: 'HOA', index: true, default: null },
    portal: { type: String, default: null, index: true },

    sentByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
      default: null,
    },
    sentByEmail: { type: String, required: true, lowercase: true, trim: true },
    sentByName: { type: String, default: null },

    documentName: { type: String, required: true, trim: true },
    templateId: { type: Number, required: true, index: true },
    templateExternalId: { type: String, default: null, index: true },
    templateSlug: { type: String, default: null },

    docusealSubmissionId: { type: Number, required: true, unique: true, index: true },
    submissionSlug: { type: String, default: null, index: true },
    submissionSource: { type: String, default: 'builder' },

    status: {
      type: String,
      enum: OVERALL_STATUSES,
      default: 'pending',
      index: true,
    },
    submitters: { type: [signerSchema], default: [] },
    signedCount: { type: Number, default: 0 },
    totalSigners: { type: Number, default: 0 },
    declinedCount: { type: Number, default: 0 },

    completedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },

    /** Original DocuSeal audit log URL (when available) */
    auditLogUrl: { type: String, default: null },
    /** S3 key after we persist the audit log PDF */
    auditLogS3Key: { type: String, default: null },
    auditLogS3Location: { type: String, default: null },
    auditLogStoredAt: { type: Date, default: null },

    combinedDocumentUrl: { type: String, default: null },

    lastWebhookAt: { type: Date, default: null },
    lastWebhookEvent: { type: String, default: null },
    webhookEvents: { type: [webhookEventSchema], default: [] },

    rawSendPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    lastDocusealSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

esignSigningRecordSchema.index({ companyId: 1, createdAt: -1 });
esignSigningRecordSchema.index({ sentByUserId: 1, createdAt: -1 });
esignSigningRecordSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('EsignSigningRecord', esignSigningRecordSchema);
module.exports.SUBMITTER_STATUSES = SUBMITTER_STATUSES;
module.exports.OVERALL_STATUSES = OVERALL_STATUSES;
