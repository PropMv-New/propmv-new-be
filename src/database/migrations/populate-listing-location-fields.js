/**
 * ------------------------------------------------------------------
 * File: populate-listing-location-fields.js
 * Module: Src Database Migrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for populate-listing-location-fields.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Migration script to populate city, state, and zip fields in listings
 * from the property's address information
 */

const mongoose = require('mongoose');
const Listing = require('../../portals/landlord/modules/listing/models/listing.model');
const Property = require('../../portals/landlord/modules/property/model/property.model');

async function populateListingLocationFields() {
  try {
    console.log('🔄 Starting migration: Populate listing location fields...');

    const listings = await Listing.find({}).lean();
    console.log(`📊 Found ${listings.length} listings to process`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const listing of listings) {
      try {
        if (listing.city && listing.state && listing.zip) {
          skipped++;
          continue;
        }

        const property = await Property.findById(listing.propertyId).lean();

        if (!property || !property.address) {
          console.warn(`⚠️  Property not found or missing address for listing ${listing._id}`);
          skipped++;
          continue;
        }

        await Listing.findByIdAndUpdate(listing._id, {
          $set: {
            city: property.address.city || listing.city,
            state: property.address.state || listing.state,
            zip: property.address.zip || listing.zip
          }
        });

        updated++;

        if (updated % 10 === 0) {
          console.log(`Processed ${updated} listings...`);
        }
      } catch (err) {
        console.error(` Error processing listing ${listing._id}:`, err.message);
        errors++;
      }
    }

    console.log('\n📈 Migration Summary:');
    console.log(`   Updated: ${updated}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`    Errors: ${errors}`);
    console.log('✨ Migration completed!\n');

  } catch (error) {
    console.error(' Migration failed:', error);
    throw error;
  }
}

if (require.main === module) {
  const dbConfig = require('../../config/db.config');

  mongoose.connect(dbConfig.url, dbConfig.options)
    .then(() => {
      console.log('Connected to database');
      return populateListingLocationFields();
    })
    .then(() => {
      console.log('Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error(' Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { populateListingLocationFields };
