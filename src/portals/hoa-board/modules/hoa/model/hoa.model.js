/**
 * ------------------------------------------------------------------
 * File: hoa.model.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * hoa.service, hoaSettings.service, userProfile.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

// Represents a single HOA organization
const HOASchema = new mongoose.Schema({
  name: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Mirrors signup / board metadata (optional; synced from primary board member user.hoaInfo or invites)
  numberOfUnits: { type: Number },
  associationType: { type: String },
  propertyAddress: { type: String },
  /** HOA-level 14-day trial. Absent on communities created before trials (legacy, unrestricted). */
  trialStartAt: { type: Date },
  trialEndAt: { type: Date },
  trialStatus: {
    type: String,
    enum: ['TRIAL', 'EXPIRED', 'SUBSCRIBED', 'CANCELLED'],
  },
  subscriptionStatus: {
    type: String,
    enum: ['NONE', 'ACTIVE', 'CANCELLED'],
  },
  trialReminders: {
    startedAt: { type: Date },
    day7At: { type: Date },
    day4SupportAt: { type: Date },
    day3At: { type: Date },
    day1At: { type: Date },
    expiredAt: { type: Date },
  },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

HOASchema.index({ createdBy: 1, isDeleted: 1 });
HOASchema.index({ name: 1, isDeleted: 1 });
HOASchema.index({ isDeleted: 1, createdAt: -1 });
HOASchema.index({ trialStatus: 1, trialEndAt: 1, isDeleted: 1 });

module.exports = mongoose.models.HOA || mongoose.model('HOA', HOASchema);
