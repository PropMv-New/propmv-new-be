/**
 * ------------------------------------------------------------------
 * File: backfill-maintenance-ticket-numbers.js
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
 * Backfill unique maintenance ticket numbers (MNT######) for legacy requests.
 *
 * Safe to re-run - only updates rows missing a valid ticket number.
 *
 * Usage:
 *   cd propmv && node scripts/backfill-maintenance-ticket-numbers.js
 *   node scripts/backfill-maintenance-ticket-numbers.js --dry-run
 *
 * Requires: MONGODB_URI, MONGO_URI, or DATABASE_URL in .env
 */

require('dotenv').config();
const mongoose = require('mongoose');
const MaintenanceRequest = require('../src/shared/modules/maintenance/model/maintenanceRequest.model');
const {
  allocateUniqueMaintenanceTicketNumber,
} = require('../src/shared/modules/maintenance/helpers/maintenanceTicketNumber.helper');

const dryRun = process.argv.includes('--dry-run');
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;

const NEEDS_TICKET_NUMBER_QUERY = {
  isDeleted: { $ne: true },
  $or: [
    { ticketNumber: { $exists: false } },
    { ticketNumber: null },
    { ticketNumber: '' },
    { ticketNumber: { $type: 'string', $not: { $regex: /^MNT\d{6}$/ } } },
  ],
};

async function backfillMaintenanceTicketNumbers() {
  if (!mongoUri) {
    throw new Error('MONGODB_URI, MONGO_URI, or DATABASE_URL environment variable is required');
  }

  console.log(`Starting maintenance ticket number backfill${dryRun ? ' (dry run)' : ''}...`);

  await mongoose.connect(mongoUri, {
    dbName: process.env.DB_NAME || undefined,
  });
  console.log('Connected to MongoDB');

  const queue = await MaintenanceRequest.find(NEEDS_TICKET_NUMBER_QUERY)
    .sort({ createdAt: 1 })
    .select('_id title ticketNumber createdAt')
    .lean();

  console.log(`Found ${queue.length} maintenance request(s) to backfill`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of queue) {
    try {
      const ticketNumber = await allocateUniqueMaintenanceTicketNumber();
      const label = doc.title ? `"${doc.title}"` : String(doc._id);

      if (dryRun) {
        console.log(`  [dry-run] ${doc._id} ${label} -> ${ticketNumber}`);
        updated += 1;
        continue;
      }

      const saved = await MaintenanceRequest.findOneAndUpdate(
        { _id: doc._id, ...NEEDS_TICKET_NUMBER_QUERY },
        { $set: { ticketNumber } },
        { new: true, select: 'ticketNumber' }
      ).lean();

      if (!saved) {
        skipped += 1;
        console.log(`  Skipped ${doc._id} (already has ticket number)`);
        continue;
      }

      console.log(`  Updated ${doc._id} ${label} -> ${saved.ticketNumber}`);
      updated += 1;
    } catch (error) {
      failed += 1;
      console.error(`  Failed ${doc._id}:`, error.message);
    }
  }

  const remaining = await MaintenanceRequest.countDocuments(NEEDS_TICKET_NUMBER_QUERY);

  console.log('\nBackfill summary');
  console.log(`  Queued: ${queue.length}`);
  console.log(`  ${dryRun ? 'Would update' : 'Updated'}: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Remaining without valid ticketNumber: ${remaining}`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  backfillMaintenanceTicketNumbers().catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });
}

module.exports = backfillMaintenanceTicketNumbers;
