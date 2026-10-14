/**
 * ------------------------------------------------------------------
 * File: ensureLandlordIndexes.js
 * Module: Src Common Db
 *
 * Purpose:
 * Backend utility/module providing helper functions for ensureLandlordIndexes.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

/**
 * Ensures MongoDB indexes used by landlord list/detail queries at scale.
 * Safe to run on every startup (createIndex is idempotent).
 */
async function ensureLandlordIndexes() {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) return;

  const Property = require('../../portals/landlord/modules/property/model/property.model');
  const Listing = require('../../portals/landlord/modules/listing/models/listing.model');
  const Application = require('../../portals/landlord/modules/application/models/application.model');

  await Promise.all([
    Property.collection.createIndex(
      { createdBy: 1, isDeleted: 1, isArchieved: 1, createdAt: -1 },
      { name: 'landlord_property_owner_list', background: true }
    ),
    Listing.collection.createIndex(
      { propertyId: 1, isDeleted: 1, status: 1, createdAt: -1 },
      { name: 'landlord_listing_property_status', background: true }
    ),
    Listing.collection.createIndex(
      { 'syndication.zillow.published': 1, status: 1, isDeleted: 1 },
      { name: 'landlord_listing_zillow_bulk', background: true, sparse: true }
    ),
    Application.collection.createIndex(
      { createdBy: 1, isDeleted: 1, status: 1, createdAt: -1 },
      { name: 'landlord_application_list', background: true }
    ),
  ]);
}

module.exports = { ensureLandlordIndexes };
