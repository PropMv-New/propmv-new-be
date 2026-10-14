/**
 * ------------------------------------------------------------------
 * File: sentEmail.model.js
 * Module: Email Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const sentEmailSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true,
  },
  to: {
    type: String,
    required: true,
  },
  cc: {
    type: String,
  },
  bcc: {
    type: String,
  },
  subject: {
    type: String,
    required: true,
  },
  body: {
    type: String,
    required: true,
  },
  sentAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, {
  timestamps: true,
});

// Compound index for efficient querying
sentEmailSchema.index({ userId: 1, sentAt: -1 });

const SentEmail = mongoose.model('SentEmail', sentEmailSchema);

module.exports = SentEmail;
