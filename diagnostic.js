/**
 * ------------------------------------------------------------------
 * File: diagnostic.js
 * Module: Backend Core
 *
 * Purpose:
 * Backend utility/module providing helper functions for diagnostic.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Property = require('./src/portals/landlord/modules/property/model/property.model');
const Application = require('./src/portals/landlord/modules/application/models/application.model');

const LANDLORD_ID = '697db8cacdd6418e078aa166';
const PROPERTY_ID = '69dfb470a9c27b5e79676f9d';
const APPLICATION_ID = '69e11d5620bc19ef3edb3904';

async function diagnose() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    // Check 1: Does the property exist?
    console.log('=== CHECK 1: Property Record ===');
    const property = await Property.findById(PROPERTY_ID).lean();
    if (property) {
      console.log('Property found:');
      console.log('  _id:', property._id);
      console.log('  landlord_id:', property.landlord_id);
      console.log('  name:', property.name || property.propertyName);
      console.log('  Match expected landlord?', property.landlord_id?.toString() === LANDLORD_ID ? 'YES' : ' NO');
    } else {
      console.log(' Property NOT found with ID:', PROPERTY_ID);
    }

    // Check 2: Does the application exist?
    console.log('\n=== CHECK 2: Application Record ===');
    const app = await Application.findById(APPLICATION_ID).lean();
    if (app) {
      console.log('Application found:');
      console.log('  _id:', app._id);
      console.log('  property_id:', app.property_id);
      console.log('  tenant_id:', app.tenant_id);
      console.log('  lease_id:', app.lease_id);
    } else {
      console.log(' Application NOT found with ID:', APPLICATION_ID);
    }

    // Check 3: Do any properties exist for this landlord?
    console.log('\n=== CHECK 3: Properties for Landlord ===');
    const landlordProperties = await Property.find({ landlord_id: LANDLORD_ID }).select('_id name').lean();
    if (landlordProperties.length > 0) {
      console.log(`Found ${landlordProperties.length} properties for landlord:`);
      landlordProperties.forEach(p => {
        console.log(`  - ${p._id} (${p.name || p.propertyName})`);
      });
    } else {
      console.log(' NO properties found for this landlord!');
      console.log('  This is why the API returns empty results.');
    }

    // Check 4: Query with correct property_id filter
    console.log('\n=== CHECK 4: Direct Query with Property Filter ===');
    const appsWithFilter = await Application.find({
      property_id: { $in: [PROPERTY_ID] },
      isDeleted: { $ne: true }
    }).lean();
    console.log(`Found ${appsWithFilter.length} applications with property_id filter`);

    // Check 5: Check if lease exists
    console.log('\n=== CHECK 5: Lease Record ===');
    const Lease = require('./src/portals/landlord/modules/leasing/model/lease.model');
    const lease = await Lease.findById(app?.lease_id).populate('property_id', '_id landlord_id').lean();
    if (lease) {
      console.log('Lease found:');
      console.log('  _id:', lease._id);
      console.log('  property_id:', lease.property_id?._id || lease.property_id);
      if (lease.property_id && lease.property_id.landlord_id) {
        console.log('  property.landlord_id:', lease.property_id.landlord_id);
      }
    } else {
      console.log(' Lease NOT found');
    }

    // Summary
    console.log('\n=== DIAGNOSIS SUMMARY ===');
    if (property && property.landlord_id?.toString() === LANDLORD_ID) {
      console.log('Property has correct landlord_id set');
      console.log('Application is correctly linked to property');
      console.log('❓ Issue might be in the query or filter logic');
    } else if (!property) {
      console.log(' PROBLEM: Property does not exist!');
      console.log('   Application property_id points to non-existent property');
    } else {
      console.log(' PROBLEM: Property exists but landlord_id does not match!');
      console.log(`   Expected: ${LANDLORD_ID}`);
      console.log(`   Actual: ${property.landlord_id}`);
      console.log('   This is why the filter returns no results');
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

diagnose();
