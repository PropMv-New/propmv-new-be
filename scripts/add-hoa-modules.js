/**
 * Script to add OWNER and COMMUNITY modules
 * 
 * This script adds the missing HOA-specific modules (OWNER and COMMUNITY)
 * to the Module collection and marks them as HOA-specific.
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

// HOA-specific modules to add
const HOA_MODULES = [
  {
    name: 'OWNER',
    description: 'Owner management module for HOA',
    functions: ['VIEW', 'CREATE', 'EDIT', 'DELETE'],
    isHoaSpecificModule: true
  },
  {
    name: 'COMMUNITY',
    description: 'Community management module for HOA',
    functions: ['VIEW', 'MANAGE'],
    isHoaSpecificModule: true
  }
];

async function addHoaModules() {
  try {
    console.log('Connecting to MongoDB...');
    console.log('Using database:', process.env.DB_NAME || 'PropMv');

    await mongoose.connect(MONGODB_URI, {
      dbName: process.env.DB_NAME || 'PropMv'
    });

    console.log('✓ Connected to MongoDB successfully\n');

    console.log('Adding HOA-specific modules...\n');

    for (const moduleData of HOA_MODULES) {
      // Check if module already exists
      const existingModule = await Module.findOne({ name: moduleData.name });

      if (existingModule) {
        console.log(`⚠️  Module "${moduleData.name}" already exists`);

        // Update it to be HOA-specific
        existingModule.isHoaSpecificModule = true;
        existingModule.description = moduleData.description;
        existingModule.functions = moduleData.functions;
        await existingModule.save();

        console.log(`✓ Updated "${moduleData.name}" to be HOA-specific\n`);
      } else {
        // Create new module
        const newModule = new Module(moduleData);
        await newModule.save();

        console.log(`✓ Created new HOA-specific module: "${moduleData.name}"`);
        console.log(`  - Description: ${moduleData.description}`);
        console.log(`  - Functions: ${moduleData.functions.join(', ')}\n`);
      }
    }

    // Display summary
    console.log('--- Summary ---\n');
    const allModules = await Module.find().lean();
    const hoaModules = allModules.filter(m => m.isHoaSpecificModule);
    const nonHoaModules = allModules.filter(m => !m.isHoaSpecificModule);

    console.log(`Total modules: ${allModules.length}`);
    console.log(`\n📋 HOA-Specific Modules (${hoaModules.length}):`);
    hoaModules.forEach(m => {
      console.log(`   - ${m.name}: ${m.functions.join(', ')}`);
    });

    console.log(`\n📋 Non-HOA Modules (${nonHoaModules.length}):`);
    console.log(`   ${nonHoaModules.map(m => m.name).join(', ')}`);

    console.log('\nHOA modules setup completed successfully!');
  } catch (error) {
    console.error('\n Error during setup:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed');
  }
}

// Run the script
addHoaModules();
