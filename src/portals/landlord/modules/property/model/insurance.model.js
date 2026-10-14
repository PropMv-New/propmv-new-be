/**
 * ------------------------------------------------------------------
 * File: insurance.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const InsuranceSchema = new Schema({
  lease_id: { type: Schema.Types.ObjectId, ref: 'Lease', required: true },
  provider_name: { type: String, required: true },
  policy_number: { type: String, required: true },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  coverage_amount: { type: Number, min: 0 },
  document_url: {
    type: String,
    validate: {
      validator: function(v) {
        return /https?:\/\/.+/.test(v);
      },
      message: 'Document URL must be a valid URL'
    }
  }
}, { timestamps: true });

module.exports = mongoose.models.Insurance || mongoose.model('Insurance', InsuranceSchema);
