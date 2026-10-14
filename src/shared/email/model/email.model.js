/**
 * ------------------------------------------------------------------
 * File: email.model.js
 * Module: Src Shared Email Model
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * email.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Legacy in-app direct emails (sender/receiver).
 * Separate model + collection from SMTP OutboundEmail (`emails`).
 */
const EmailSchema = new Schema({
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  receiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject: { type: String, required: true, maxlength: 500 },
  content: { type: String, required: true, maxlength: 10000 },
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  isDeleted: { type: Boolean, default: false }
}, {
  timestamps: true,
  // Same physical collection as outbound SMTP rows; different model name avoids mongoose collision.
  collection: 'emails',
});

EmailSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
EmailSchema.index({ receiverId: 1, isRead: 1 });
EmailSchema.index({ isDeleted: 1 });

module.exports =
  mongoose.models.PortalEmail ||
  mongoose.model('PortalEmail', EmailSchema);
