'use strict';

const mongoose = require('mongoose');

const notificationLogSchema = new mongoose.Schema(
  {
    notificationId: { type: String, required: true, trim: true, index: true },
    jobId: { type: String, default: '', trim: true, index: true },
    type: { type: String, required: true, trim: true },
    channel: {
      type: String,
      enum: ['in-app', 'email', 'push', 'other'],
      default: 'in-app',
    },
    recipientType: { type: String, default: '', trim: true },
    recipientId: { type: String, default: '', trim: true, index: true },
    recipientEmail: { type: String, default: '', trim: true },
    entityType: { type: String, default: '', trim: true },
    entityId: { type: String, default: '', trim: true, index: true },
    activityId: { type: String, default: '', trim: true },
    subject: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed', 'skipped', 'retrying'],
      default: 'queued',
      index: true,
    },
    providerMessageId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    errorMessage: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    workerId: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    collection: 'notification_logs',
  }
);

notificationLogSchema.index({ createdAt: -1 });
notificationLogSchema.index({ type: 1, createdAt: -1 });
notificationLogSchema.index({ jobId: 1, recipientId: 1 });

module.exports =
  mongoose.models.NotificationLog ||
  mongoose.model('NotificationLog', notificationLogSchema);
