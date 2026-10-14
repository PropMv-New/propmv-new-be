/**
 * ------------------------------------------------------------------
 * File: addressApiUsage.model.js
 * Module: Src Shared Modules Address Model
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * quota.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Tracks how many address-autocomplete requests were served per provider per
 * calendar month (UTC). Used to decide when Google's monthly free quota is
 * exhausted so the system can fall back to Mapbox.
 *
 * One document per (provider, period) pair, e.g. { provider: 'google', period: '2026-06' }.
 */
const AddressApiUsageSchema = new Schema(
  {
    provider: { type: String, required: true, enum: ['google', 'mapbox'] },
    // Calendar month bucket in UTC, formatted as YYYY-MM.
    period: { type: String, required: true },
    autocompleteCount: { type: Number, default: 0 },
    resolveCount: { type: Number, default: 0 },
    totalCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

AddressApiUsageSchema.index({ provider: 1, period: 1 }, { unique: true });

module.exports =
  mongoose.models.AddressApiUsage || mongoose.model('AddressApiUsage', AddressApiUsageSchema);
