/**
 * ------------------------------------------------------------------
 * File: seedPropertyMasterDropdowns.js
 * Module: Src Scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for seedPropertyMasterDropdowns.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Script to seed property dropdown master data
 * Run: node src/scripts/seedPropertyMasterDropdowns.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MasterData = require('../shared/modules/master/model/masterData.model');

const PROPERTY_DROPDOWN_MASTERS = [
  {
    type: 'Landlord_Property',
    key: 'Landlord_Ownership_Types',
    data: [
      { label: 'Individual', value: 'individual' },
      { label: 'Join ownership', value: 'joint-ownership' },
      { label: 'LLC', value: 'llc' },
      { label: 'Corporation', value: 'corporation' },
      { label: 'Trust', value: 'trust' },
      { label: 'Partnership', value: 'partnership' },
    ],
  },
  {
    type: 'Landlord_Property',
    key: 'Landlord_Account_Types',
    data: [
      { label: 'Checking', value: 'checking' },
      { label: 'Savings', value: 'savings' },
    ],
  },
  {
    type: 'Landlord_Property',
    key: 'Landlord_Entity_Types',
    data: [
      { label: 'Individual', value: 'individual' },
      { label: 'LLC', value: 'llc' },
      { label: 'Corporation', value: 'corporation' },
      { label: 'Trust', value: 'trust' },
      { label: 'Partnership', value: 'partnership' },
    ],
  },
  {
    type: 'Landlord_Property',
    key: 'Landlord_Late_Fee_Types',
    data: [
      { label: 'Percentage of Total Amount', value: 'percentage-total' },
      { label: 'Percentage of Outstanding', value: 'percentage-outstanding' },
      { label: 'Flat Fee', value: 'flat-fee' },
    ],
  },
  {
    type: 'Landlord_Property',
    key: 'Landlord_Late_Fee_End_After',
    data: [
      ...Array.from({ length: 31 }, (_, i) => ({
        label: `${i + 1} day${i + 1 === 1 ? '' : 's'}`,
        value: String(i + 1),
      })),
      { label: '45 days', value: '45' },
      { label: '60 days', value: '60' },
      { label: '90 days', value: '90' },
      { label: 'Never', value: 'never' },
    ],
  },
];

async function seedPropertyDropdowns() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/propmv_landlord');
    console.log('Connected to MongoDB');

    for (const record of PROPERTY_DROPDOWN_MASTERS) {
      const existing = await MasterData.findOne({ key: record.key });
      if (existing) {
        await MasterData.updateOne({ key: record.key }, { $set: record });
        console.log(`Updated ${record.key}`);
      } else {
        await MasterData.create(record);
        console.log(`Created ${record.key}`);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error(' Error seeding property dropdown masters:', error.message);
    process.exit(1);
  }
}

seedPropertyDropdowns();
