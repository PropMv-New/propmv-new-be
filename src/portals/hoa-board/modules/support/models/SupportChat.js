/**
 * ------------------------------------------------------------------
 * File: SupportChat.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for SupportChat.
 *
 * Used By:
 * supportChatService
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const supportChatSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  hoaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'HOA'
  },
  messages: [{
    text: {
      type: String,
      required: true
    },
    sender: {
      type: String,
      enum: ['user', 'support'],
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  status: {
    type: String,
    enum: ['open', 'closed'],
    default: 'open'
  },
  closedAt: Date
}, {
  timestamps: true
});

module.exports = mongoose.model('SupportChat', supportChatSchema);
