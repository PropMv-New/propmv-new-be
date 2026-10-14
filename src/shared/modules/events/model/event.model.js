/**
 * ------------------------------------------------------------------
 * File: event.model.js
 * Module: Events Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * invoice.service, tenant.service, event.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const EventSchema = new Schema({
  event: { type: String, required: true },
  from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  notificationDate: { type: Date, required: true },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  unit: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.models.Event || mongoose.model('Event', EventSchema);
