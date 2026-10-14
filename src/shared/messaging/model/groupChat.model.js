const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const GroupMemberSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  joinedAt: { type: Date, default: Date.now },
  addedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { _id: false });

const GroupChatSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  hoaId: { type: Schema.Types.ObjectId, ref: 'HOA', index: true, default: null },
  members: { type: [GroupMemberSchema], default: [] },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

GroupChatSchema.index({ 'members.userId': 1, isDeleted: 1 });
GroupChatSchema.index({ hoaId: 1, isDeleted: 1 });

GroupChatSchema.methods.getMemberIds = function getMemberIds() {
  return (this.members || []).map((m) => String(m.userId));
};

GroupChatSchema.statics.findActiveForUser = function findActiveForUser(userId) {
  return this.find({
    isDeleted: { $ne: true },
    'members.userId': userId,
  });
};

module.exports = mongoose.models.GroupChat || mongoose.model('GroupChat', GroupChatSchema);
