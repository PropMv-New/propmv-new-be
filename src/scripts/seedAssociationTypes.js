/**
 * ------------------------------------------------------------------
 * File: seedAssociationTypes.js
 * Module: Src Scripts
 *
 * Purpose:
 * Backend utility/module providing helper functions for seedAssociationTypes.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Seed HOA association/property types into masterdata.
 * Run from propmv/: node src/scripts/seedAssociationTypes.js
 */

const path = require('path');
const mongoose = require('mongoose');

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local';
require('dotenv').config({ path: path.join(__dirname, '../../', envFile) });
require('dotenv').config();

const MasterData = require('../shared/modules/master/model/masterData.model');
const { MASTER_DATA_KEYS } = require('../common/constants/masterDataKeys');

const ASSOCIATION_TYPES = {
  type: 'HOA_Signup',
  key: MASTER_DATA_KEYS.HOA_ASSOCIATION_TYPES,
  data: [
    { label: 'Condo', value: 'Condo' },
    { label: 'Apartment', value: 'Apartment' },
    { label: 'Villa', value: 'Villa' },
    { label: 'Townhouse', value: 'Townhouse' },
    { label: 'Single Family Homes', value: 'Single Family Homes' },
    { label: 'Land', value: 'Land' },
  ],
};

/**
 * resolve Mongo Uri
 *
 * Performs logic operations for resolveMongoUri.
 *
 * @returns Operations result
 */
function resolveMongoUri() {
  return (
    process.env.DB_URL ||
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    'mongodb://localhost:27017/propmv_landlord'
  );
}

async function seed() {
  try {
    const mongoUri = resolveMongoUri();
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const existing = await MasterData.findOne({ key: ASSOCIATION_TYPES.key });
    if (existing) {
      await MasterData.updateOne({ key: ASSOCIATION_TYPES.key }, { $set: ASSOCIATION_TYPES });
      console.log(`Updated ${ASSOCIATION_TYPES.key}`);
    } else {
      await MasterData.create(ASSOCIATION_TYPES);
      console.log(`Created ${ASSOCIATION_TYPES.key}`);
    }

    process.exit(0);
  } catch (err) {
    console.error(' Seed error:', err.message);
    process.exit(1);
  }
}

seed();
