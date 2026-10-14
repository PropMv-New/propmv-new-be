/**
 * ------------------------------------------------------------------
 * File: seedHOARequestTypes.js
 * Module: Src Scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for seedHOARequestTypes.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Script to seed HOA Request Types into Master Data
 * Run: node src/scripts/seedHOARequestTypes.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MasterData = require('../shared/modules/master/model/masterData.model');

const HOA_REQUEST_TYPES = {
  type: 'HOA_RequestType',
  key: 'HOA_Primary_RequestTypes',
  data: [
    {
      primary: 'Maintenance',
      icon: '🔧',
      subTypes: [
        { name: 'Common Area', icon: '🏢' },
        { name: 'Pool Area', icon: '🏊' },
        { name: 'Gym Area', icon: '💪' },
        { name: 'ClubHouse', icon: '🏛️' },
        { name: 'Landscaping', icon: '🌳' },
        { name: 'Pest Control', icon: '🐛' },
        { name: 'Other Maintenance', icon: '🔨' }
      ]
    },
    {
      primary: 'Architectural',
      icon: '🏗️',
      subTypes: [
        { name: 'Fence', icon: '🚧' },
        { name: 'Roof', icon: '🏠' },
        { name: 'Siding', icon: '🎨' },
        { name: 'Windows/Doors', icon: '🪟' },
        { name: 'Driveway/Walkway', icon: '🛣️' },
        { name: 'Other Architectural', icon: '📐' }
      ]
    },
    {
      primary: 'Violations',
      icon: '⚠️',
      subTypes: [
        { name: 'Noise Complaint', icon: '🔊' },
        { name: 'Parking Violation', icon: '🅿️' },
        { name: 'Pet Violation', icon: '🐕' },
        { name: 'Other Violation', icon: '' }
      ]
    },
    {
      primary: 'General',
      icon: '📋',
      subTypes: [
        { name: 'General', icon: '📋' }
      ]
    }
  ]
};

async function seedData() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/propmv_landlord');
    console.log('Connected to MongoDB');

    // Check if HOA request types already exist
    const existing = await MasterData.findOne({ key: 'HOA_Primary_RequestTypes' });

    if (existing) {
      console.log('⚠️  HOA Request Types already exist. Updating...');
      await MasterData.updateOne(
        { key: 'HOA_Primary_RequestTypes' },
        { $set: HOA_REQUEST_TYPES }
      );
      console.log('HOA Request Types updated successfully');
    } else {
      console.log('📝 Creating new HOA Request Types...');
      await MasterData.create(HOA_REQUEST_TYPES);
      console.log('HOA Request Types created successfully');
    }

    // Verify the data
    const saved = await MasterData.findOne({ key: 'HOA_Primary_RequestTypes' });
    console.log('\n📊 Saved data:');
    console.log(JSON.stringify(saved, null, 2));

    process.exit(0);
  } catch (error) {
    console.error(' Error seeding data:', error.message);
    process.exit(1);
  }
}

seedData();
