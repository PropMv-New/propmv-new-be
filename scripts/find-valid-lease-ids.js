/**
 * ------------------------------------------------------------------
 * File: find-valid-lease-ids.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Script to find valid lease and tenant IDs for testing
 * Run this script to get real IDs from your database
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.DB_URL || 'mongodb://localhost:27017/propmv';
const DB_NAME = process.env.DB_NAME || 'PropMv';

async function findValidLeaseIds() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB\n');

    // Find any lease in the database
    const Lease = mongoose.model('Lease', new mongoose.Schema({}, { strict: false, collection: 'leases' }));

    const leases = await Lease.find({}).limit(5).lean();

    if (leases.length === 0) {
      console.log(' No leases found in the database!');
      console.log('\n📝 You need to create a lease first through the application:');
      console.log('   1. Go to http://localhost:8080');
      console.log('   2. Navigate to "Add New Tenant & Lease"');
      console.log('   3. Complete the lease creation flow');
      console.log('   4. Then run this script again to get the IDs\n');
    } else {
      console.log(`Found ${leases.length} lease(s) in the database:\n`);

      leases.forEach((lease, index) => {
        console.log(`📋 Lease ${index + 1}:`);
        console.log(`   Lease ID: ${lease._id}`);
        console.log(`   Status: ${lease.status || 'N/A'}`);
        console.log(`   Property ID: ${lease.property_id || 'N/A'}`);

        // Get tenant IDs from the lease
        const split = lease.rentAndDepositDestribution?.split || [];
        if (split.length > 0) {
          console.log(`   Tenants on this lease:`);
          split.forEach((s, idx) => {
            const tenantId = s.tenantId?._id || s.tenantId;
            console.log(`      Tenant ${idx + 1} ID: ${tenantId}`);
          });

          // Generate the screening URL
          const firstTenantId = split[0].tenantId?._id || split[0].tenantId;
          console.log(`\n   🔗 Screening URL for Tenant 1:`);
          console.log(`   http://localhost:8080/application/screening?leaseId=${lease._id}&tenantId=${firstTenantId}`);
        } else {
          console.log(`   ⚠️  No tenants found on this lease`);
        }
        console.log('');
      });

      console.log('\nCopy one of the URLs above and test it in your browser!');
    }

  } catch (error) {
    console.error(' Error:', error.message);
    console.error('\n💡 Make sure:');
    console.error('   1. MongoDB is running');
    console.error('   2. The MONGODB_URI in .env is correct');
    console.error('   3. The database name is correct\n');
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

findValidLeaseIds();
