/**
 * ------------------------------------------------------------------
 * File: migrate-hoa-unit-scope.js
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
 * Migration: Backfill HOA-scoping fields on unit properties and invoices created before
 * server-side stamping of createdBy / hoaId (fixes invisible units & invoices for board members).
 *
 * Safe to re-run - only fills missing fields; skips rows that cannot be inferred.
 *
 * Usage:
 *   cd propmv && node scripts/migrate-hoa-unit-scope.js
 *   node scripts/migrate-hoa-unit-scope.js --dry-run
 *
 * Requires: MONGO_URI or DATABASE_URL (see .env)
 */

require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

/** Resolve actual collection names (HOAMembership pluralization varies by mongoose version). */
const HOAMembership = require(path.join(
  __dirname,
  '../src/portals/hoa-board/modules/hoa/model/hoaMembership.model.js'
));

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL;
const dryRun = process.argv.includes('--dry-run');

if (!MONGO_URI) {
  console.error('MONGO_URI / DATABASE_URL env var is required');
  process.exit(1);
}

/**
 * missing Ref
 *
 * Performs logic operations for missingRef.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function missingRef(value) {
  return value == null || value === '';
}

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function migratePropertyHoaIds(propertiesColl, membershipsColl, dry) {
  const cursor = propertiesColl.find({
    isDeleted: { $ne: true },
    $or: [{ hoaId: { $exists: false } }, { hoaId: null }],
    landlord_id: { $exists: true, $nin: [null] },
  });

  let scanned = 0;
  let updated = 0;
  let ambiguous = 0;
  let skippedNoMembership = 0;

  for await (const prop of cursor) {
    scanned++;
    const landlordId = toObjectId(prop.landlord_id);
    if (!landlordId) { skippedNoMembership++; continue; }
    const memberships = await membershipsColl
      .find({ userId: landlordId, status: 'active' })
      .project({ hoaId: 1 })
      .toArray();

    if (!memberships.length) {
      skippedNoMembership++;
      continue;
    }

    const hoaIds = [...new Set(memberships.map((m) => String(m.hoaId)))];
    const chosen = memberships[0].hoaId;

    if (hoaIds.length > 1) {
      ambiguous++;
      console.warn(
        `  [property ${prop._id}] landlord in multiple HOAs (${hoaIds.join(', ')}); using first active: ${chosen}`
      );
    }

    if (!dry) {
      await propertiesColl.updateOne({ _id: toObjectId(prop._id) }, { $set: { hoaId: chosen } });
    }
    updated++;
  }

  console.log('\n--- Properties: set hoaId from active HOAMembership (landlord_id) ---');
  console.log(`  scanned: ${scanned}, updated: ${updated}, no membership: ${skippedNoMembership}, ambiguous HOA: ${ambiguous}`);
}

async function migratePropertyLandlordFromInvoices(propertiesColl, invoicesColl, dry) {
  /** Invoices may have createdBy while property.landlord_id was never set */
  const agg = await invoicesColl
    .aggregate([
      {
        $match: {
          isDeleted: { $ne: true },
          createdBy: { $exists: true, $nin: [null] },
          propertyId: { $exists: true, $nin: [null] },
        },
      },
      {
        $group: {
          _id: '$propertyId',
          createdBy: { $first: '$createdBy' },
        },
      },
    ])
    .toArray();

  let updated = 0;
  let skipped = 0;

  for (const row of agg) {
    const safePropId = toObjectId(row._id);
    if (!safePropId) { skipped++; continue; }
    const prop = await propertiesColl.findOne(
      { _id: safePropId },
      { projection: { landlord_id: 1 } }
    );
    if (!prop || !missingRef(prop.landlord_id)) {
      skipped++;
      continue;
    }
    const safeCreatedBy = toObjectId(row.createdBy);
    if (!safeCreatedBy) { skipped++; continue; }
    if (!dry) {
      await propertiesColl.updateOne({ _id: safePropId }, { $set: { landlord_id: safeCreatedBy } });
    }
    updated++;
    console.log(`  [property ${safePropId}] set landlord_id from invoice.createdBy`);
  }

  console.log('\n--- Properties: set landlord_id from invoice.createdBy (when missing) ---');
  console.log(`  updated: ${updated}, skipped (already has landlord or no prop): ${skipped}`);
}

async function migrateInvoiceCreatedBy(propertiesColl, invoicesColl, dry) {
  const invoices = await invoicesColl
    .find({
      $or: [{ createdBy: { $exists: false } }, { createdBy: null }],
      isDeleted: { $ne: true },
      propertyId: { $exists: true, $nin: [null] },
    })
    .project({ _id: 1, propertyId: 1 })
    .toArray();

  let updated = 0;
  let skippedNoLandlord = 0;

  for (const inv of invoices) {
    const safeInvPropId = toObjectId(inv.propertyId);
    if (!safeInvPropId) { skippedNoLandlord++; continue; }
    const prop = await propertiesColl.findOne(
      { _id: safeInvPropId },
      { projection: { landlord_id: 1 } }
    );
    if (!prop || missingRef(prop.landlord_id)) {
      skippedNoLandlord++;
      continue;
    }
    const safeLandlordId = toObjectId(prop.landlord_id);
    if (!safeLandlordId) { skippedNoLandlord++; continue; }
    const safeInvId = toObjectId(inv._id);
    if (!safeInvId) { skippedNoLandlord++; continue; }
    if (!dry) {
      await invoicesColl.updateOne({ _id: safeInvId }, { $set: { createdBy: safeLandlordId } });
    }
    updated++;
  }

  console.log('\n--- Invoices: set createdBy from property.landlord_id ---');
  console.log(`  scanned (missing createdBy): ${invoices.length}, updated: ${updated}, no landlord on property: ${skippedNoLandlord}`);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to MongoDB${dryRun ? ' [DRY RUN - no writes]' : ''}\n`);

  const db = mongoose.connection.db;
  const propertiesColl = db.collection('properties');
  const invoicesColl = db.collection('invoices');
  const membershipsColl = db.collection(HOAMembership.collection.collectionName);

  // 1) Properties missing landlord_id: copy from an invoice on that property that already has createdBy.
  // 2) Properties missing hoaId: infer from active HOAMembership for landlord_id.
  // 3) Invoices missing createdBy: copy property.landlord_id.
  await migratePropertyLandlordFromInvoices(propertiesColl, invoicesColl, dryRun);
  await migratePropertyHoaIds(propertiesColl, membershipsColl, dryRun);
  await migrateInvoiceCreatedBy(propertiesColl, invoicesColl, dryRun);

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
