/**
 * ------------------------------------------------------------------
 * File: fix-property-manager-user.js
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
 * Fix Script: Assign Company and Role to Existing Property Manager User
 * 
 * This script fixes Property Manager users who were created but don't have
 * companyId and companyRoleId assigned.
 */

const mongoose = require('mongoose');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const User = require('../src/shared/modules/users/models/user.model');
const Company = require('../src/shared/modules/company/models/company.model');
const {
  createCompanyForPropertyManager,
  assignCompanyRoleToUser
} = require('../src/shared/modules/company/helpers/companyCreation.helper');

async function fixPropertyManagerUser() {
  try {
    console.log('🚀 Starting Property Manager User Fix...\n');

    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/propmv';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB\n');

    // Find the specific Property Manager user without company
    const userId = '6a1d7f0c9e0f1e36a8e4733a'; // The user ID from your data

    const user = await User.findById(userId);
    if (!user) {
      console.log(' User not found');
      return;
    }

    console.log(`📋 Found user: ${user.firstName} ${user.lastName} (${user.email})`);
    console.log(`   Current role: ${user.role}`);
    console.log(`   Current companyId: ${user.companyId}`);
    console.log(`   Current companyRoleId: ${user.companyRoleId}\n`);

    // Check if user already has company
    if (user.companyId && user.companyRoleId) {
      console.log('User already has company and role assigned');
      return;
    }

    // Check if company exists for this user
    let company = await Company.findOne({
      ownerId: user._id,
      isDeleted: { $ne: true }
    });

    if (!company) {
      // Create company
      console.log('📝 Creating company for user...');
      company = await createCompanyForPropertyManager({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        _id: user._id,
      });
      console.log(`Company created: ${company.name} (${company._id})\n`);
    } else {
      console.log(`Company already exists: ${company.name} (${company._id})\n`);
    }

    // Assign company role to user
    console.log('📝 Assigning Administrator role to user...');
    await assignCompanyRoleToUser(user, company);

    // Verify the update
    const updatedUser = await User.findById(userId);
    console.log('\nUser updated successfully:');
    console.log(`   Company ID: ${updatedUser.companyId}`);
    console.log(`   Company Role ID: ${updatedUser.companyRoleId}`);
    console.log(`   Role field: ${updatedUser.role}`);

    // Verify company role
    const verifyCompany = await Company.findById(updatedUser.companyId);
    const adminRole = verifyCompany.roles.id(updatedUser.companyRoleId);
    console.log(`\nAdministrator Role Details:`);
    console.log(`   Name: ${adminRole.name}`);
    console.log(`   Privileges: ${adminRole.privileges.length}`);
    console.log(`   Active: ${adminRole.isActive}`);

    console.log('\n' + '='.repeat(60));
    console.log('Fix completed successfully!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error(' Fix failed:', error);
    console.error(error.stack);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

// Run fix
fixPropertyManagerUser()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n Script failed:', error);
    process.exit(1);
  });
