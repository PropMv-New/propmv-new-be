/**
 * ------------------------------------------------------------------
 * File: fix-property-landlord-name-unit-index.js
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
 * Drops the legacy unique index { landlord_id, name } on properties and ensures
 * the compound unique index { landlord_id, name, unitDetails.0.unitName } exists.
 *
 * Run from repo root (with MONGO_URI / DB env as in your app):
 *   node scripts/fix-property-landlord-name-unit-index.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const LEGACY_INDEX = 'landlord_id_1_name_1';
const NEW_INDEX_SPEC = { landlord_id: 1, name: 1, 'unitDetails.0.unitName': 1 };

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URL;
  if (!uri) {
    console.error('Set MONGO_URI (or MONGODB_URI / DB_URL) in .env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const coll = mongoose.connection.collection('properties');
  let indexes = await coll.indexes();
  const hasLegacy = indexes.some((ix) => ix.name === LEGACY_INDEX);
  if (hasLegacy) {
    await coll.dropIndex(LEGACY_INDEX);
    console.log(`Dropped index ${LEGACY_INDEX}`);
  } else {
    console.log(`Index ${LEGACY_INDEX} not present (already migrated or different DB)`);
  }
  indexes = await coll.indexes();
  const hasNew = indexes.some(
    (ix) =>
      ix.key &&
      ix.key.landlord_id === 1 &&
      ix.key.name === 1 &&
      ix.key['unitDetails.0.unitName'] === 1
  );
  if (!hasNew) {
    await coll.createIndex(NEW_INDEX_SPEC, { unique: true });
    console.log('Created compound unique index: landlord_id + name + unitDetails.0.unitName');
  } else {
    console.log('Compound index already exists; skipping createIndex');
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
