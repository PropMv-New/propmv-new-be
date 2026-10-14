/**
 * ------------------------------------------------------------------
 * File: email.model.js
 * Module: Email Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * email.controller, email.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { EMAIL_STATUS, ALL_EMAIL_STATUSES } = require('../../../../common/constants/emailStatus');
const { EMAIL_ORIGIN, ALL_EMAIL_ORIGINS } = require('../../../../common/constants/emailOrigin');

/**
 * Outbound SMTP email records (draft / sent / failed) + system email audit log.
 * Model name is OutboundEmail to avoid colliding with shared/email's legacy Email model.
 * Collection stays `emails` so existing data continues to work.
 */
const emailSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    ref: 'User',
    index: true,
  },
  /** Active HOA community when composed from the HOA portal (x-hoa-id). */
  hoaId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    ref: 'HOA',
    index: true,
    default: null,
  },
  /** user = Email-tab compose; system = automated / template mail */
  origin: {
    type: String,
    enum: ALL_EMAIL_ORIGINS,
    default: EMAIL_ORIGIN.USER,
    index: true,
  },
  /** Template name for system emails (invite, invoice, …) */
  templateName: {
    type: String,
    default: '',
    index: true,
  },
  /** SMTP provider message id when available */
  messageId: {
    type: String,
    default: '',
  },
  to: {
    type: String,
  },
  cc: {
    type: String,
  },
  bcc: {
    type: String,
  },
  subject: {
    type: String,
  },
  body: {
    type: String,
  },
  status: {
    type: String,
    enum: ALL_EMAIL_STATUSES,
    default: EMAIL_STATUS.DRAFT,
    required: true,
    index: true,
  },
  sentAt: {
    type: Date,
    index: true,
  },
  errorMessage: {
    type: String,
  },
  attachments: [{
    documentMetadataId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DocumentMetadata',
      required: true,
    },
    filename: String,
    originalName: String,
    size: Number,
    mimetype: String,
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  }],
  isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },
}, {
  timestamps: true,
  collection: 'emails',
});

// Compound indexes for efficient querying
emailSchema.index({ userId: 1, status: 1, updatedAt: -1 });
emailSchema.index({ userId: 1, status: 1, sentAt: -1 });
emailSchema.index({ userId: 1, isDeleted: 1, status: 1 });
emailSchema.index({ origin: 1, status: 1, sentAt: -1 });
emailSchema.index({ userId: 1, hoaId: 1, status: 1, sentAt: -1 });
emailSchema.index({ userId: 1, hoaId: 1, status: 1, updatedAt: -1 });

const Email =
  mongoose.models.OutboundEmail ||
  mongoose.model('OutboundEmail', emailSchema);

module.exports = Email;
