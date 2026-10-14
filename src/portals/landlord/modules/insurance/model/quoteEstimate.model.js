/**
 * ------------------------------------------------------------------
 * File: quoteEstimate.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * quoteEstimate.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AddressSchema = new Schema({
  street_address: { type: String, default: null },
  city: { type: String, default: null },
  state: { type: String, default: null },
  zip_code: { type: String, default: null },
  county: { type: String, default: null },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
}, { _id: false });

const PropertyDetailsSchema = new Schema({
  // Required for instant estimate; optional for regular estimate
  property_type: {
    type: String,
    enum: ['SINGLE_FAMILY', 'DUPLEX', 'TRIPLEX', 'QUADPLEX', 'APARTMENT_BUILDING', 'MOBILE_HOME', 'OTHER', null],
    default: null,
  },
  size_sqft: { type: Number, default: null },
  year_built: { type: Number, default: null },
  // Optional for both
  number_of_units: { type: Number, default: null },
  replacement_value: { type: Number, default: null },
  stories: { type: Number, default: null },
  land_value: { type: Number, default: null },
  occupancy_type: { type: String, enum: ['fix_and_flip', 'rental', null], default: null },
  // Deprecated but kept for regular estimate compatibility
  rent: { type: Number, default: null },
  occupancy: { type: Number, default: null },
  bedrooms: { type: Number, default: null },
  bathrooms: { type: Number, default: null },
}, { _id: false });

const RequestPropertySchema = new Schema({
  property_id: { type: String, required: true },
  current_premium: { type: Number, default: null },
  address: { type: AddressSchema, default: () => ({}) },
  property_details: { type: PropertyDetailsSchema, default: null },
  property_metadata: {
    extra: { type: String, default: null },
  },
}, { _id: false });

const PrimaryInsuredSchema = new Schema({
  first_name: { type: String, default: null },
  last_name: { type: String, default: null },
  email: { type: String, default: null },
  phone_number: { type: String, default: null },
  date_of_birth: { type: String, default: null },
  company_name: { type: String, default: null },
  mailing_address: { type: AddressSchema, default: null },
}, { _id: false });

const EstimateSchema = new Schema({
  lowest: { type: Number, default: null },
  dp_1: { type: Number, default: null },
  dp_3: { type: Number, default: null },
}, { _id: false });

const SavingsSchema = new Schema({
  current_premium: { type: Number, default: null },
  lowest: { type: Number, default: null },
  savings: { type: Number, default: null },
}, { _id: false });

const PropertyEstimateSchema = new Schema({
  property_id: { type: String },
  start_url: { type: String, default: null },
  error: { type: String, default: null },
  estimate: { type: EstimateSchema, default: null },
  savings: { type: SavingsSchema, default: null },
  minimum_earned_premium_days: { type: Number, default: null },
}, { _id: false });

const QuoteEstimateSchema = new Schema({
  // The logged-in user who requested the estimate
  user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // Kept for landlord-scoped queries
  landlord_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },

  // 'quote' = /v1/quote/estimate, 'instant' = /v1/quote/instant-estimate
  estimate_type: { type: String, enum: ['quote', 'instant'], required: true },

  request: {
    properties: { type: [RequestPropertySchema], required: true },
    primary_insured: { type: PrimaryInsuredSchema, default: null },
    metadata: {
      extra: { type: String, default: null },
    },
  },

  // Full raw response stored for reference
  response: { type: Schema.Types.Mixed, default: null },

  // Parsed estimates for quick access
  estimates: { type: [PropertyEstimateSchema], default: [] },

  status: { type: String, enum: ['success', 'partial', 'failed'], default: 'success' },
  steadily_error: { type: String, default: null },
}, { timestamps: true });

QuoteEstimateSchema.index({ landlord_id: 1, createdAt: -1 });
QuoteEstimateSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.models.QuoteEstimate || mongoose.model('QuoteEstimate', QuoteEstimateSchema);
