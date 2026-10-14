/**
 * Script to mark HOA-specific modules
 * 
 * This script updates the Module collection to set isHoaSpecificModule flag
 * for modules that are specific to HOA (Homeowners Association) management.
 * 
 * HOA-specific modules: OWNER, COMMUNITY
 */

const mongoose = require('mongoose');
const Module = require('../src/shared/modules/auth/models/module.model');
require('dotenv').config({ path: '.env.local' });

// Get MongoDB connection string from environment
const MONGODB_URI = process.env.DB_URL;

if (!MONGODB_URI) {
  console.error(' DB_URL not found in environment variables');
  console.error('Please ensure .env.local file exists and contains DB_URL');
  process.exit(1);
}

// Modules that are HOA-specific
const HOA_SPECIFIC_MODULES = [
  'OWNER',
  'COMMUNITY'
];

async function markHoaSpecificModules() {
  try {
    console.log('Connecting to MongoDB...');
    console.log('Using database:', process.env.DB_NAME || 'PropMv');

    await mongoose.connect(MONGODB_URI, {
      dbName: process.env.DB_NAME || 'PropMv'
    });

    console.log('✓ Connected to MongoDB successfully\n');

    // Check existing modules first
    const allModulesCount = await Module.countDocuments();
    console.log(`Found ${allModulesCount} modules in database`);

    if (allModulesCount === 0) {
      console.log('\n⚠️  No modules found in database.');
      console.log('Please ensure modules are seeded before running this script.');
      await mongoose.connection.close();
      return;
    }

    console.log('\nMarking HOA-specific modules...');

    // Mark HOA-specific modules
    const hoaResult = await Module.updateMany(
      { name: { $in: HOA_SPECIFIC_MODULES } },
      { $set: { isHoaSpecificModule: true } }
    );

    console.log(`✓ Marked ${hoaResult.modifiedCount} modules as HOA-specific:`, HOA_SPECIFIC_MODULES.join(', '));

    // Mark all other modules as NOT HOA-specific
    const nonHoaResult = await Module.updateMany(
      { name: { $nin: HOA_SPECIFIC_MODULES } },
      { $set: { isHoaSpecificModule: false } }
    );

    console.log(`✓ Marked ${nonHoaResult.modifiedCount} modules as NOT HOA-specific`);

    // Display summary
    console.log('\n--- Summary ---');
    const allModules = await Module.find().lean();
    const hoaModules = allModules.filter(m => m.isHoaSpecificModule);
    const nonHoaModules = allModules.filter(m => !m.isHoaSpecificModule);

    console.log('\n📋 HOA-Specific Modules:', hoaModules.length > 0 ? hoaModules.map(m => m.name).join(', ') : 'None');
    console.log('📋 Non-HOA Modules:', nonHoaModules.length > 0 ? nonHoaModules.map(m => m.name).join(', ') : 'None');

    console.log('\nMigration completed successfully!');
  } catch (error) {
    console.error('\n Error during migration:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed');
  }
}

// Run the migration
markHoaSpecificModules();
