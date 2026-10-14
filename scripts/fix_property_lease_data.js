/**
 * ------------------------------------------------------------------
 * File: fix_property_lease_data.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Usage: node fix_property_lease_data.js
// This script will ensure your property and lease documents are consistent for invoice creation.

const mongoose = require('mongoose');

const PROPERTY_ID = '6a12acb30de850e661c823b4';
const UNIT_ID = '6a12acb30de850e661c823b5';
const UNIT_NAME = 'Unit 1';
const LEASE_ID = '6a12e56567ff38a0bb71188f';

const MONGO_URI = 'mongodb://localhost:27017/YOUR_DB_NAME'; // <-- Change this to your DB

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection;

  // Update property
  const property = await db.collection('properties').findOne({ _id: mongoose.Types.ObjectId(PROPERTY_ID) });
  if (!property) {
    console.error('Property not found');
    process.exit(1);
  }
  let found = false;
  const updatedUnits = (property.unitDetails || []).map(u => {
    if (String(u._id) === UNIT_ID || u.unitName === UNIT_NAME) {
      found = true;
      return { ...u, _id: mongoose.Types.ObjectId(UNIT_ID), unitName: UNIT_NAME };
    }
    return u;
  });
  if (!found) {
    updatedUnits.push({ _id: mongoose.Types.ObjectId(UNIT_ID), unitName: UNIT_NAME, unitType: 'apartment', squareFeet: 100 });
  }
  await db.collection('properties').updateOne(
    { _id: mongoose.Types.ObjectId(PROPERTY_ID) },
    { $set: { unitDetails: updatedUnits } }
  );
  console.log('Property updated.');

  // Update lease
  const lease = await db.collection('leases').findOne({ _id: mongoose.Types.ObjectId(LEASE_ID) });
  if (!lease) {
    console.error('Lease not found');
    process.exit(1);
  }
  await db.collection('leases').updateOne(
    { _id: mongoose.Types.ObjectId(LEASE_ID) },
    { $set: {
      property_id: mongoose.Types.ObjectId(PROPERTY_ID),
      unitId: mongoose.Types.ObjectId(UNIT_ID),
      unitName: UNIT_NAME
    } }
  );
  console.log('Lease updated.');

  await mongoose.disconnect();
  console.log('Done.');
}

if (require.main === module) {
  run();
}
