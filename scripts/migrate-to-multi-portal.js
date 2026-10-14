#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 * File: migrate-to-multi-portal.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function migrateToMultiPortal() {
  try {
    console.log('🚀 Starting multi-portal migration...\n');

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    const db = mongoose.connection.db;

    // Step 1: Add indexes for performance
    console.log('📊 Adding database indexes...');
    try {
      await db.collection('properties').createIndex({ landlord_id: 1 });
      await db.collection('properties').createIndex({ hoaBoardMemberId: 1 });
      await db.collection('leases').createIndex({ landlord_id: 1 });
      await db.collection('expenses').createIndex({ landlord_id: 1 });
      await db.collection('invoices').createIndex({ landlord_id: 1 });
      await db.collection('maintenancerequests').createIndex({ landlord_id: 1 });
      console.log('Indexes created\n');
    } catch (err) {
      console.log('⚠️  Some indexes may already exist\n');
    }

    // Step 2: Add landlord role if not exists
    console.log('👤 Checking landlord role...');
    const rolesCollection = db.collection('roles');
    const landlordRole = await rolesCollection.findOne({ name: 'landlord' });

    if (!landlordRole) {
      await rolesCollection.insertOne({
        name: 'landlord',
        description: 'Property owner/landlord managing rental properties',
        permissions: [
          'property:read',
          'property:create',
          'property:update',
          'property:delete',
          'tenant:read',
          'tenant:create',
          'tenant:update',
          'lease:read',
          'lease:create',
          'lease:update',
          'maintenance:read',
          'maintenance:create',
          'expense:read',
          'expense:create',
          'invoice:read',
          'invoice:create',
          'listing:read',
          'listing:create',
          'listing:update'
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log('Landlord role created\n');
    } else {
      console.log('Landlord role already exists\n');
    }

    // Step 3: Ensure HOA properties have hoaBoardMemberId
    console.log('🏘️  Updating HOA properties...');
    const usersCollection = db.collection('users');
    const propertiesCollection = db.collection('properties');

    const hoaRole = await rolesCollection.findOne({ name: 'hoa_board' });
    if (hoaRole) {
      const hoaUsers = await usersCollection.find({ role: hoaRole._id }).toArray();

      for (const hoaUser of hoaUsers) {
        const result = await propertiesCollection.updateMany(
          {
            createdBy: hoaUser._id,
            hoaBoardMemberId: { $exists: false }
          },
          {
            $set: { hoaBoardMemberId: hoaUser._id }
          }
        );

        if (result.modifiedCount > 0) {
          console.log(`  Updated ${result.modifiedCount} properties for HOA user ${hoaUser.email}`);
        }
      }
    }
    console.log('HOA properties updated\n');

    // Step 4: Statistics
    console.log('📈 Migration Statistics:');
    const totalProperties = await propertiesCollection.countDocuments();
    const hoaProperties = await propertiesCollection.countDocuments({ hoaBoardMemberId: { $exists: true } });
    const landlordProperties = await propertiesCollection.countDocuments({
      landlord_id: { $exists: true },
      hoaBoardMemberId: { $exists: false }
    });

    console.log(`  Total Properties: ${totalProperties}`);
    console.log(`  HOA Properties: ${hoaProperties}`);
    console.log(`  Landlord Properties: ${landlordProperties}`);
    console.log(`  Unassigned: ${totalProperties - hoaProperties - landlordProperties}\n`);

    // Step 5: Verify indexes
    console.log('🔍 Verifying indexes...');
    const indexes = await propertiesCollection.indexes();
    const hasLandlordIndex = indexes.some(idx => idx.key.landlord_id);
    const hasHOAIndex = indexes.some(idx => idx.key.hoaBoardMemberId);

    console.log(`  landlord_id index: ${hasLandlordIndex ? '' : ''}`);
    console.log(`  hoaBoardMemberId index: ${hasHOAIndex ? '' : ''}\n`);

    console.log('🎉 Migration completed successfully!\n');
    console.log('Next steps:');
    console.log('1. Test HOA portal: /api/v1/portal/hoa/property');
    console.log('2. Test Landlord portal: /api/v1/portal/landlord/property');
    console.log('3. Update frontend to use new portal routes');
    console.log('4. Create test landlord users\n');

  } catch (error) {
    console.error(' Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
  }
}

// Run migration
migrateToMultiPortal();
