/**
 * ------------------------------------------------------------------
 * File: zillowFeedState.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * zillowFeedFileService
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Tracks bulk feed generation state for Zillow threshold protection.
 */
const ZillowFeedStateSchema = new Schema({
  feedId: { type: String, required: true, unique: true },
  lastSuccessfulRunAt: { type: Date },
  lastSuccessfulListingCount: { type: Number },
  lastFilePath: { type: String },
  lastFileSize: { type: Number },
  pendingConfirmation: { type: Boolean, default: false },
  pendingListingCount: { type: Number },
  lastThresholdBreachAt: { type: Date },
  lastThresholdPercent: { type: Number },
}, { timestamps: true });

module.exports = mongoose.models.ZillowFeedState
  || mongoose.model('ZillowFeedState', ZillowFeedStateSchema);
