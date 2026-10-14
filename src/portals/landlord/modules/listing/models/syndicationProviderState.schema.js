/**
 * ------------------------------------------------------------------
 * File: syndicationProviderState.schema.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * listing.model
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { SYNDICATION_SYNC_STATUS } = require('../../../../../integrations/syndication/syndication.constants');

const SyndicationProviderStateSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  published: { type: Boolean, default: false },
  feedListingId: { type: String },
  lastSyncedAt: { type: Date },
  lastSyncStatus: {
    type: String,
    enum: Object.values(SYNDICATION_SYNC_STATUS),
  },
  lastSyncError: { type: String },
  publishedAt: { type: Date },
  unpublishedAt: { type: Date },
}, { _id: false });

module.exports = SyndicationProviderStateSchema;
