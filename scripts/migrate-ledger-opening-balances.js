/**
 * ------------------------------------------------------------------
 * File: migrate-ledger-opening-balances.js
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
 * Migration: Seed opening_balance ledger entries for existing units.
 *
 * Run once:
 *   node scripts/migrate-ledger-opening-balances.js
 *
 * Safe to re-run - skips units that already have an opening_balance entry.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error('MONGO_URI / DATABASE_URL env var is required');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const propertyColl = mongoose.connection.collection('properties');
  const ledgerColl = mongoose.connection.collection('ledgerentries');

  // Find all non-deleted units that have billing configuration
  const units = await propertyColl.find({
    isDeleted: { $ne: true },
    $or: [
      { startingBalance: { $ne: 0 } },
      { balanceAsOf: { $exists: true, $ne: null } }
    ]
  }, {
    projection: { _id: 1, startingBalance: 1, balanceAsOf: 1, name: 1 }
  }).toArray();

  console.log(`Found ${units.length} units with billing configuration`);

  let created = 0;
  let skipped = 0;

  for (const unit of units) {
    // Skip if opening_balance entry already exists
    const existing = await ledgerColl.findOne({
      unitId: unit._id,
      type: 'opening_balance'
    });

    if (existing) {
      skipped++;
      continue;
    }

    const amount = typeof unit.startingBalance === 'number' ? unit.startingBalance : 0;
    const createdAt = unit.balanceAsOf ? new Date(unit.balanceAsOf) : new Date();

    await ledgerColl.insertOne({
      unitId: unit._id,
      type: 'opening_balance',
      amount,
      createdAt,
      metadata: { source: 'migration', unitName: unit.name }
    });

    created++;
    console.log(`  ✓ ${unit.name} - opening_balance: ${amount >= 0 ? '+' : ''}${amount}`);
  }

  console.log(`\nMigration complete: ${created} created, ${skipped} skipped (already existed)`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
