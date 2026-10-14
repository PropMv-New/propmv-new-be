/**
 * ------------------------------------------------------------------
 * File: auditLog.model.js
 * Module: Audit Logging Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * auditLog.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema(
  {
    module: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    event: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    action: {
      type: String,
      trim: true,
      index: true,
    },
    entity: {
      type: String,
      trim: true,
      index: true,
    },
    entityId: {
      type: String,
      trim: true,
      index: true,
    },
    portal: {
      type: String,
      trim: true,
      index: true,
    },
    hoaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HOA',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },
    userName: {
      type: String,
      default: '',
      trim: true,
    },
    userRole: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ipAddress: {
      type: String,
      default: '',
      trim: true,
    },
    deviceInfo: {
      type: String,
      default: '',
      trim: true,
    },
    browserInfo: {
      type: String,
      default: '',
      trim: true,
    },
    sessionId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    correlationId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    requestId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    success: {
      type: Boolean,
      default: true,
      index: true,
    },
    failureReason: {
      type: String,
      default: '',
      trim: true,
    },
    /** Links final AuditLog row to outbox eventId for idempotent delivery */
    auditEventId: {
      type: String,
      default: '',
      trim: true,
    },
    /** Origin of the action: USER, ADMIN, WEBHOOK, SCHEDULER, SYSTEM */
    source: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
  },
  {
    timestamps: false,
    minimize: false,
  }
);

AuditLogSchema.index({ module: 1, event: 1, createdAt: -1 });
AuditLogSchema.index({ portal: 1, hoaId: 1, createdAt: -1 });
AuditLogSchema.index({ createdBy: 1, createdAt: -1 });
AuditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
AuditLogSchema.index({ source: 1, createdAt: -1 });
AuditLogSchema.index(
  { auditEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { auditEventId: { $type: 'string', $gt: '' } },
  }
);
AuditLogSchema.index({ requestId: 1, createdAt: -1 });
AuditLogSchema.index({ correlationId: 1, createdAt: -1 });
AuditLogSchema.index({ hoaId: 1, createdAt: -1 });

AuditLogSchema.pre('findOneAndUpdate', function blockAuditMutation() {
  throw new Error('Audit logs are immutable');
});
AuditLogSchema.pre('updateOne', function blockAuditMutation() {
  throw new Error('Audit logs are immutable');
});
AuditLogSchema.pre('updateMany', function blockAuditMutation() {
  throw new Error('Audit logs are immutable');
});
AuditLogSchema.pre('deleteOne', function blockAuditDeletion() {
  throw new Error('Audit logs are immutable');
});
AuditLogSchema.pre('deleteMany', function blockAuditDeletion() {
  throw new Error('Audit logs are immutable');
});
AuditLogSchema.pre('remove', function blockAuditDeletion() {
  throw new Error('Audit logs are immutable');
});

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
