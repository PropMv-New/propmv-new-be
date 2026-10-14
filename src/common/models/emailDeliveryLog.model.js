/**
 * ------------------------------------------------------------------
 * File: emailDeliveryLog.model.js
 * Module: Src Common Models
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * transactionalEmail.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const EmailDeliveryLogSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true, index: true },
    templateName: { type: String, required: true },
    recipientEmail: { type: String, required: true, index: true },
    entityType: { type: String, default: '' },
    entityId: { type: String, default: '' },
    status: {
      type: String,
      enum: ['sent', 'failed', 'skipped_duplicate', 'skipped_disabled'],
      required: true,
    },
    errorMessage: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

EmailDeliveryLogSchema.index({ eventKey: 1, status: 1 });
EmailDeliveryLogSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.EmailDeliveryLog ||
  mongoose.model('EmailDeliveryLog', EmailDeliveryLogSchema);
