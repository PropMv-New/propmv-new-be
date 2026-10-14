/**
 * ------------------------------------------------------------------
 * File: message.model.js
 * Module: Src Shared Messaging Model
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * owner.service, message.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const MessageReceiptSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  deliveredAt: { type: Date, default: null },
  isRead: { type: Boolean, default: false },
  readAt: { type: Date, default: null },
}, { _id: false });

const MessageSchema = new Schema({
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  receiverId: { type: Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  groupId: { type: Schema.Types.ObjectId, ref: 'GroupChat', index: true, default: null },
  content: { type: String, maxlength: 5000 },
  attachments: [{
    filename: String,
    originalName: String,
    mimeType: String,
    size: Number,
    url: String
  }],
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  // null until the receiver has an active socket session (WhatsApp-style single → double tick)
  deliveredAt: { type: Date, default: null },
  // Per-member delivery/read tracking for group messages
  receipts: { type: [MessageReceiptSchema], default: undefined },
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

MessageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
MessageSchema.index({ groupId: 1, createdAt: -1 });
MessageSchema.index({ receiverId: 1, isRead: 1 });
MessageSchema.index({ isDeleted: 1 });
MessageSchema.index({ 'receipts.userId': 1, 'receipts.isRead': 1 });

MessageSchema.pre('validate', function validateDirectOrGroup(next) {
  const hasReceiver = Boolean(this.receiverId);
  const hasGroup = Boolean(this.groupId);
  if (hasReceiver === hasGroup) {
    return next(new Error('Message must have either receiverId (direct) or groupId (group), not both'));
  }
  return next();
});

const { commonQueryHelpersPlugin } = require('../../../common/db/schemaPlugins');
const { toObjectId } = require('../../../common/db/mongooseHelpers');

commonQueryHelpersPlugin(MessageSchema);

MessageSchema.statics.findRecentForUser = function findRecentForUser(userId, limit = 10) {
  const userObjectId = toObjectId(userId);
  return this.find({
    isDeleted: { $ne: true },
    $or: [{ senderId: userObjectId }, { receiverId: userObjectId }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec();
};

MessageSchema.statics.formatHistoryForOwner = function formatHistoryForOwner(messages, owner) {
  const ownerId = String(owner._id);
  const ownerName = `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Owner';

  return (messages || []).map((msg) => {
    const isOwnerSender = String(msg.senderId) === ownerId;
    const isOwnerReceiver = String(msg.receiverId) === ownerId;
    return {
      to: isOwnerReceiver ? ownerName : 'Admin',
      from: isOwnerSender ? ownerName : 'Admin',
      subject: msg.content ? String(msg.content).slice(0, 80) : '',
      date: msg.createdAt,
    };
  });
};

// Optional: Auto-delete messages after 1 year (uncomment if needed)
// MessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 });

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);
