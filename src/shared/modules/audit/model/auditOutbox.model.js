'use strict';

const mongoose = require('mongoose');

const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const errorHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    message: { type: String, default: '' },
    code: { type: String, default: '' },
  },
  { _id: false }
);

const auditOutboxSchema = new mongoose.Schema(
  {
    /** Unique audit-event id (UUID) - written to AuditLog.auditEventId on delivery */
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    /** Dedup key for enqueue - prevents duplicate outbox rows on HTTP/webhook retry */
    idempotencyKey: {
      type: String,
      default: null,
      trim: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(OUTBOX_STATUS),
      default: OUTBOX_STATUS.PENDING,
      index: true,
    },
    retryCount: { type: Number, default: 0, min: 0 },
    maxRetries: { type: Number, default: 10, min: 1 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null, index: true },
    lockedBy: { type: String, default: '', trim: true },
    lastError: { type: String, default: '', trim: true },
    errorHistory: { type: [errorHistorySchema], default: [] },
    auditLogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AuditLog',
      default: null,
      index: true,
    },
    processedAt: { type: Date, default: null },
    replayHistory: {
      type: [{
        at: { type: Date, default: Date.now },
        initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        outcome: { type: String, default: '' },
        note: { type: String, default: '' },
      }],
      default: [],
    },
  },
  { timestamps: true }
);

auditOutboxSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
auditOutboxSchema.index(
  { idempotencyKey: 1 },
  { unique: true, sparse: true }
);

const AuditOutboxModel = mongoose.models.AuditOutbox
  || mongoose.model('AuditOutbox', auditOutboxSchema);

module.exports = AuditOutboxModel;
module.exports.OUTBOX_STATUS = OUTBOX_STATUS;
