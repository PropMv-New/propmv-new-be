/**
 * ------------------------------------------------------------------
 * File: listing.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * app, ensureLandlordIndexes, propertyRelatedQueries, populate-listing-location-fields
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { LISTING_STATUS, PAYMENT_FREQUENCY, LEASE_TYPE } = require('../../../../../common/constants/listing');
const SyndicationProviderStateSchema = require('./syndicationProviderState.schema');

const ListingSchema = new Schema({
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  // Legacy denormalized fields kept optional for backward compatibility.
  // Canonical source is propertyId -> Property document.
  propertyName: { type: String },
  propertyType: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zip: { type: String },
  unitId: { type: Schema.Types.ObjectId },
  // Optional legacy copies; canonical unit display lives on Property.unitDetails for unitId.
  unitName: { type: String },
  bedrooms: { type: Number, min: 0 },
  bathrooms: { type: Number, min: 0 },
  area: { type: Number, min: 0 },
  listingHeadline: { type: String, required: true },
  description: { type: String, required: true },
  rentalAmount: { type: Number, required: true, min: 0 },
  securityDeposit: { type: Number, required: true, min: 0 },
  paymentFrequency: { 
    type: String, 
    required: true,
    enum: Object.values(PAYMENT_FREQUENCY)
  },
  availableDate: { type: Date, required: true },
  leaseType: { 
    type: String, 
    required: true,
    enum: Object.values(LEASE_TYPE)
  },
  petPolicies: [{ type: String }],
  utilitiesIncluded: [{ type: String }],
  amenities: [{ type: String }],
  images: [{
    isCover: { type: Boolean, default: false },
    resolution: { type: String },
    documentMetaDataId: { type: Schema.Types.ObjectId, ref: 'DocumentMetadata', required: true }
  }],
  virtualTourVideoUrl: { type: String },
  syndicationPlatforms: [{ type: String }],
  syndication: {
    zillow: { type: SyndicationProviderStateSchema, default: () => ({}) },
    // TODO: extend for apartmentsCom, realtorCom, etc.
  },
  isAcceptingApplications: { type: Boolean, default: true },
  status: { 
    type: String, 
    required: true,
    enum: Object.values(LISTING_STATUS),
    default: LISTING_STATUS.ACTIVE
  },
  comments: [{
    text: { type: String, required: true },
    action: { type: String, required: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
  }],
  isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Index for efficient queries
ListingSchema.index({ propertyId: 1, unitName: 1 });
ListingSchema.index({ propertyId: 1, unitId: 1 });
ListingSchema.index({ status: 1 });
ListingSchema.index({ availableDate: 1 });
ListingSchema.index({ city: 1 });
ListingSchema.index({ state: 1 });
ListingSchema.index({ zip: 1 });
ListingSchema.index({ isDeleted: 1 });

const { toObjectId, exactUnitNameRegex } = require('../../../../../common/db/mongooseHelpers');
const { commonQueryHelpersPlugin } = require('../../../../../common/db/schemaPlugins');

commonQueryHelpersPlugin(ListingSchema);

const ACTIVE_LISTING_STATUSES = ['Active', 'Published', 'Publish_InProgress'];

ListingSchema.statics.findActiveByPropertyIds = function findActiveByPropertyIds(propertyIds, options = {}) {
  const { select = { _id: 1, propertyId: 1, unitName: 1, status: 1 }, lean = true } = options;
  const ids = propertyIds.map(toObjectId);
  let query = this.find({
    propertyId: { $in: ids },
    status: { $in: ACTIVE_LISTING_STATUSES },
  }).select(select);

  return lean ? query.lean().exec() : query.exec();
};

ListingSchema.statics.findActiveByProperty = function findActiveByProperty(propertyId, unitName) {
  const filter = {
    propertyId: toObjectId(propertyId),
    status: { $in: ACTIVE_LISTING_STATUSES },
  };
  if (unitName) filter.unitName = exactUnitNameRegex(unitName);
  return this.findOne(filter).lean().exec();
};

module.exports = mongoose.models.Listing || mongoose.model('Listing', ListingSchema);