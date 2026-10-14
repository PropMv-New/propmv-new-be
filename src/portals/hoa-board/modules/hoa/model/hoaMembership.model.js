/**
 * ------------------------------------------------------------------
 * File: hoaMembership.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * contacts.service, noteReminder.service, hoaDataIsolation, hoa.controller
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

// Links a user to an HOA - supports invite flow and multi-HOA membership
const HOAMembershipSchema = new mongoose.Schema({
  hoaId: { type: mongoose.Schema.Types.ObjectId, ref: 'HOA', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  email: { type: String, required: true, lowercase: true },
  role: { type: String, enum: ['admin', 'member'], default: 'member' },
  status: { type: String, enum: ['pending', 'active', 'revoked'], default: 'pending' },
  inviteToken: { type: String },
  inviteTokenExpiresAt: { type: Date },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

HOAMembershipSchema.index({ hoaId: 1, email: 1 }, { unique: true });
HOAMembershipSchema.index({ inviteToken: 1 });
HOAMembershipSchema.index({ hoaId: 1, status: 1 });
HOAMembershipSchema.index({ userId: 1, status: 1 });
HOAMembershipSchema.index({ hoaId: 1, userId: 1, status: 1 });

module.exports = mongoose.models.HOAMembership || mongoose.model('HOAMembership', HOAMembershipSchema);
