/**
 * ------------------------------------------------------------------
 * File: create-default-propmv-company.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Company = require('../src/shared/modules/company/models/company.model');
const { ROLE_NAMES } = require('../src/common/constants/roleNames');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env.local');
const fs = require('fs');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const DEFAULT_PROPMV_ROLES = [
  { name: ROLE_NAMES.LANDLORD, description: 'Landlord user role with full access to all modules', privileges: [], isActive: true },
  { name: ROLE_NAMES.PROPERTY_MANAGER, description: 'Manages multiple properties and tenant relationships', privileges: [], isActive: true },
  { name: ROLE_NAMES.HOA_BOARD_MEMBER, description: 'Manages community, owners, finances, and maintenance', privileges: [], isActive: true },
  { name: ROLE_NAMES.HOA_OWNER, description: 'HOA unit owner with limited access', privileges: [], isActive: true },
  { name: ROLE_NAMES.TENANT, description: 'Tenant user role', privileges: [], isActive: true },
];

/**
 * Create the default PropMv company with embedded signup/platform roles.
 * Usage: node scripts/create-default-propmv-company.js
 */
async function createDefaultPropMvCompany() {
  try {
    console.log('🚀 Starting PropMv default company creation...\n');

    const mongoUri = process.env.MONGODB_URI || process.env.DB_URL || 'mongodb://localhost:27017/propmv';
    console.log(`📡 Connecting to MongoDB: ${mongoUri.replace(/\/\/[^@]*@/, '//*****@')}`);

    await mongoose.connect(mongoUri, {
      dbName: process.env.DB_NAME || 'PropMv',
    });
    console.log('Connected to MongoDB\n');

    const existingCompany = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });

    if (existingCompany) {
      console.log('ℹ️  PropMv company already exists');
      console.log(`   ID: ${existingCompany._id}`);
      console.log(`   Roles count: ${existingCompany.roles.length}`);
      console.log(`   Active roles: ${existingCompany.roles.filter((r) => r.isActive).length}\n`);
      await mongoose.disconnect();
      process.exit(0);
    }

    console.log('🏢 Creating PropMv default company...');
    const propMvCompany = await Company.create({
      name: 'PropMv',
      description: 'Default company for PropMv platform users',
      roles: DEFAULT_PROPMV_ROLES,
      isActive: true,
      isDeleted: false,
      contactInfo: {
        email: 'support@propmv.com',
        website: 'https://propmv.com',
      },
      settings: {
        timezone: 'America/New_York',
        currency: 'USD',
        dateFormat: 'MM/DD/YYYY',
      },
      subscription: {
        plan: 'enterprise',
        status: 'active',
        startDate: new Date(),
      },
    });

    console.log(`PropMv company created with ${propMvCompany.roles.length} roles`);
    console.log(`   Company ID: ${propMvCompany._id}\n`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('\n Error during company creation:', error.message);
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    process.exit(1);
  }
}

createDefaultPropMvCompany();
