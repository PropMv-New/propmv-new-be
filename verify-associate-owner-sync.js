/**
 * ------------------------------------------------------------------
 * File: verify-associate-owner-sync.js
 * Module: Backend Core
 *
 * Purpose:
 * Backend utility/module providing helper functions for verify-associate-owner-sync.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Data Verification Script for Associate Owner Bidirectional Sync
 * 
 * This script checks the consistency of the bidirectional relationship
 * between Properties and Owners (Users).
 * 
 * Run this script with: node verify-associate-owner-sync.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/propmv';

async function verifyBidirectionalSync() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const Property = mongoose.model('Property');
    const User = mongoose.model('User');

    console.log('\n📊 Starting Bidirectional Sync Verification...\n');

    // Get all properties with associated owners
    const properties = await Property.find({
      associatedOwnerIds: { $exists: true, $ne: [] },
      isDeleted: { $ne: true }
    }).lean();

    console.log(`Found ${properties.length} properties with associated owners\n`);

    let totalChecks = 0;
    let passedChecks = 0;
    let failedChecks = 0;
    const issues = [];

    // Check each property
    for (const property of properties) {
      const propertyId = property._id.toString();
      const ownerIds = (property.associatedOwnerIds || []).map(id => id.toString());

      console.log(`\n🏠 Checking Property: ${property.name} (${propertyId})`);
      console.log(`   Associated Owners: ${ownerIds.length}`);

      // Check each associated owner
      for (const ownerId of ownerIds) {
        totalChecks++;

        const owner = await User.findById(ownerId).lean();

        if (!owner) {
          failedChecks++;
          const issue = ` Owner ${ownerId} not found (referenced by property ${propertyId})`;
          console.log(`   ${issue}`);
          issues.push(issue);
          continue;
        }

        const ownerPropertyIds = (owner.propertyIds || []).map(id => id.toString());
        const hasProperty = ownerPropertyIds.includes(propertyId);

        if (hasProperty) {
          passedChecks++;
          console.log(`   Owner ${owner.email} has property in propertyIds`);
        } else {
          failedChecks++;
          const issue = ` Owner ${owner.email} (${ownerId}) missing property ${propertyId} in propertyIds`;
          console.log(`   ${issue}`);
          issues.push({
            type: 'MISSING_PROPERTY_IN_OWNER',
            ownerId,
            ownerEmail: owner.email,
            propertyId,
            propertyName: property.name,
            fix: `db.users.updateOne({ _id: ObjectId("${ownerId}") }, { $addToSet: { propertyIds: ObjectId("${propertyId}") } })`
          });
        }
      }
    }

    // Check owners with properties
    console.log('\n\n👥 Checking Owners with Properties...\n');

    const owners = await User.find({
      propertyIds: { $exists: true, $ne: [] },
      isDeleted: { $ne: true }
    }).lean();

    console.log(`Found ${owners.length} owners with properties\n`);

    for (const owner of owners) {
      const ownerId = owner._id.toString();
      const propertyIds = (owner.propertyIds || []).map(id => id.toString());

      console.log(`\n👤 Checking Owner: ${owner.email} (${ownerId})`);
      console.log(`   Associated Properties: ${propertyIds.length}`);

      for (const propertyId of propertyIds) {
        totalChecks++;

        const property = await Property.findById(propertyId).lean();

        if (!property) {
          failedChecks++;
          const issue = ` Property ${propertyId} not found (referenced by owner ${ownerId})`;
          console.log(`   ${issue}`);
          issues.push({
            type: 'MISSING_PROPERTY',
            ownerId,
            ownerEmail: owner.email,
            propertyId,
            fix: `db.users.updateOne({ _id: ObjectId("${ownerId}") }, { $pull: { propertyIds: ObjectId("${propertyId}") } })`
          });
          continue;
        }

        const propertyOwnerIds = (property.associatedOwnerIds || []).map(id => id.toString());
        const hasOwner = propertyOwnerIds.includes(ownerId);

        if (hasOwner) {
          passedChecks++;
          console.log(`   Property ${property.name} has owner in associatedOwnerIds`);
        } else {
          failedChecks++;
          const issue = ` Property ${property.name} (${propertyId}) missing owner ${ownerId} in associatedOwnerIds`;
          console.log(`   ${issue}`);
          issues.push({
            type: 'MISSING_OWNER_IN_PROPERTY',
            ownerId,
            ownerEmail: owner.email,
            propertyId,
            propertyName: property.name,
            fix: `db.properties.updateOne({ _id: ObjectId("${propertyId}") }, { $addToSet: { associatedOwnerIds: ObjectId("${ownerId}") } })`
          });
        }
      }
    }

    // Summary
    console.log('\n\n' + '='.repeat(80));
    console.log('📋 VERIFICATION SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total Checks: ${totalChecks}`);
    console.log(`Passed: ${passedChecks}`);
    console.log(` Failed: ${failedChecks}`);
    console.log(`Success Rate: ${totalChecks > 0 ? ((passedChecks / totalChecks) * 100).toFixed(2) : 0}%`);

    if (issues.length > 0) {
      console.log('\n\n' + '='.repeat(80));
      console.log('🔧 ISSUES FOUND - FIX COMMANDS');
      console.log('='.repeat(80));

      issues.forEach((issue, index) => {
        if (typeof issue === 'string') {
          console.log(`\n${index + 1}. ${issue}`);
        } else {
          console.log(`\n${index + 1}. ${issue.type}`);
          console.log(`   Owner: ${issue.ownerEmail} (${issue.ownerId})`);
          if (issue.propertyName) {
            console.log(`   Property: ${issue.propertyName} (${issue.propertyId})`);
          } else {
            console.log(`   Property: ${issue.propertyId}`);
          }
          console.log(`   Fix: ${issue.fix}`);
        }
      });

      console.log('\n\n' + '='.repeat(80));
      console.log('🔧 BULK FIX SCRIPT (MongoDB Shell)');
      console.log('='.repeat(80));
      console.log('\n// Copy and paste this into MongoDB shell to fix all issues:\n');

      issues.forEach(issue => {
        if (typeof issue === 'object' && issue.fix) {
          console.log(issue.fix);
        }
      });
    } else {
      console.log('\nAll bidirectional relationships are properly synchronized!');
    }

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');

  } catch (error) {
    console.error(' Error:', error);
    process.exit(1);
  }
}

// Run the verification
verifyBidirectionalSync();
