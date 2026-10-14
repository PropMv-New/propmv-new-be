/**
 * ------------------------------------------------------------------
 * File: emailConfig.model.js
 * Module: Email Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * smtpConfig.controller, email.service, imap.service, smtp.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const emailConfigSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  provider: {
    type: String,
    enum: ['gmail', 'smtp'],
    required: true
  },
  // SMTP fields
  smtpHost: String,
  smtpPort: Number,
  smtpUser: String,
  smtpPassword: String,
  fromName: String,
  // IMAP fields (for reading emails)
  imapHost: String,
  imapPort: Number,
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  verifiedAt: Date
}, {
  timestamps: true
});

emailConfigSchema.index({ userId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.models.EmailConfig || mongoose.model('EmailConfig', emailConfigSchema);
