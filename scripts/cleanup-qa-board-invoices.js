/**
 * Hard-delete stale HOA invoices belonging to the QA board fixture account
 * and/or the QA Test Community, so QA runs can reset invoice state without
 * touching any other tenant's data on shared staging.
 *
 * Scope (OR):
 *   - invoices with createdBy == qa.board@propmv.com's user id
 *   - invoices with hoaId == the "QA Test Community" HOA's id
 *   - invoices with propertyName == "QA Test Community" (invoices store this
 *     directly - see invoice.model.js - and it's what QA property invoices
 *     actually carry, so this catches them even when hoaId isn't populated)
 * AND updatedAt older than the staleness cutoff (default 2 days) - a fresh
 * invoice created moments ago by a running suite is never touched.
 *
 * Safety: dry-run by default. Nothing is deleted unless --apply is passed.
 *
 * Run:
 *   node scripts/cleanup-qa-board-invoices.js               (dry run, 2-day cutoff)
 *   node scripts/cleanup-qa-board-invoices.js --days=5       (dry run, 5-day cutoff)
 *   node scripts/cleanup-qa-board-invoices.js --apply        (actually deletes)
 *   node scripts/cleanup-qa-board-invoices.js --days=5 --apply
 *
 * Required env (from .env.local):
 *   DB_URL or MONGODB_URI
 *   DB_NAME (default: PropMv)
 *
 * Optional:
 *   QA_BOARD_EMAIL          (default: qa.board@propmv.com)
 *   QA_HOA_NAME              (default: QA Test Community)
 *   INVOICE_CLEANUP_DAYS     (default: 2; overridden by --days)
 */

'use strict';

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const DB_URL = process.env.DB_URL || process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'PropMv';
const QA_BOARD_EMAIL = (process.env.QA_BOARD_EMAIL || 'qa.board@propmv.com').toLowerCase();
const QA_HOA_NAME = process.env.QA_HOA_NAME || 'QA Test Community';

function parseArgs(argv) {
  const args = { apply: false, days: undefined };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw.startsWith('--days=')) args.days = Number(raw.slice('--days='.length));
  }
  return args;
}

async function run() {
  const { apply, days: cliDays } = parseArgs(process.argv.slice(2));
  const staleDays = Number.isFinite(cliDays) && cliDays > 0
    ? cliDays
    : Number(process.env.INVOICE_CLEANUP_DAYS) || 2;

  if (!DB_URL) {
    console.error('DB_URL or MONGODB_URI is required');
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

  console.log('═'.repeat(70));
  console.log('  Cleanup QA Board Invoices');
  console.log('═'.repeat(70));
  console.log(`Board account:   ${QA_BOARD_EMAIL}`);
  console.log(`HOA community:   ${QA_HOA_NAME}`);
  console.log(`Stale cutoff:    updatedAt < ${cutoff.toISOString()} (${staleDays} day(s))`);
  console.log(`Mode:            ${apply ? 'APPLY (hard delete)' : 'DRY RUN (no changes)'}`);
  console.log(`Database:        ${DB_NAME}\n`);

  await mongoose.connect(DB_URL, { dbName: DB_NAME });
  console.log('Connected to MongoDB.\n');

  const User = require('../src/shared/modules/users/models/user.model');
  const HOA = require('../src/portals/hoa-board/modules/hoa/model/hoa.model');
  const Invoice = require('../src/portals/hoa-board/modules/invoice/model/invoice.model');

  const boardUser = await User.findOne({ email: QA_BOARD_EMAIL, isDeleted: { $ne: true } });
  const hoa = await HOA.findOne({ name: QA_HOA_NAME, isDeleted: { $ne: true } });

  if (!boardUser) console.log(`  (no user found for ${QA_BOARD_EMAIL})`);
  if (!hoa) console.log(`  (no HOA found named "${QA_HOA_NAME}")`);

  if (!boardUser && !hoa) {
    console.log('\nNothing to scope the cleanup to. Exiting without changes.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const scopeOr = [];
  if (boardUser) scopeOr.push({ createdBy: boardUser._id });
  if (hoa) scopeOr.push({ hoaId: hoa._id });
  scopeOr.push({ propertyName: QA_HOA_NAME });

  const filter = {
    $or: scopeOr,
    updatedAt: { $lt: cutoff },
  };

  const matches = await Invoice.find(filter)
    .select({ invoiceId: 1, status: 1, balanceDue: 1, hoaId: 1, propertyName: 1, createdBy: 1, updatedAt: 1 })
    .lean();

  console.log(`\nMatched ${matches.length} invoice(s):`);
  for (const inv of matches) {
    console.log(`  - ${inv.invoiceId}  status=${inv.status}  balanceDue=${inv.balanceDue}  updatedAt=${inv.updatedAt?.toISOString?.() || inv.updatedAt}`);
  }

  if (!matches.length) {
    console.log('\nNo matching invoices. Nothing to delete.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!apply) {
    console.log(`\nDry run only - re-run with --apply to hard-delete these ${matches.length} invoice(s).`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const ids = matches.map((inv) => inv._id);
  const result = await Invoice.deleteMany({ _id: { $in: ids } });
  console.log(`\n✓ Hard-deleted ${result.deletedCount} invoice(s).`);
  console.log(`Deleted count: ${result.deletedCount}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('\nCleanup failed:', err.message);
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
