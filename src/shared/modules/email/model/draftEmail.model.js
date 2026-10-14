/**
 * ------------------------------------------------------------------
 * File: draftEmail.model.js
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

const draftEmailSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true,
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
}, {
  timestamps: true,
});

draftEmailSchema.index({ userId: 1, updatedAt: -1 });

const DraftEmail = mongoose.model('DraftEmail', draftEmailSchema);

module.exports = DraftEmail;
