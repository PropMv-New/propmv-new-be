/**
 * ------------------------------------------------------------------
 * File: syndicationLog.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * zillowFeedFileService, zillowFeedReportService, ZillowSyndicationProvider
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { SYNDICATION_ACTIONS } = require('../../../../../integrations/syndication/syndication.constants');

const SyndicationLogSchema = new Schema({
  provider: { type: String, required: true, index: true },
  listingId: { type: Schema.Types.ObjectId, ref: 'Listing', index: true },
  action: {
    type: String,
    enum: Object.values(SYNDICATION_ACTIONS),
    required: true,
  },
  requestPayloadSize: { type: Number },
  response: { type: Schema.Types.Mixed },
  success: { type: Boolean, required: true, index: true },
  durationMs: { type: Number },
  error: { type: String },
}, { timestamps: true });

SyndicationLogSchema.index({ provider: 1, createdAt: -1 });
SyndicationLogSchema.index({ listingId: 1, provider: 1, createdAt: -1 });

module.exports = mongoose.models.SyndicationLog
  || mongoose.model('SyndicationLog', SyndicationLogSchema);
