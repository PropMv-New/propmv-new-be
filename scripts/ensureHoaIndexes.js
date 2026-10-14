#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 * File: ensureHoaIndexes.js
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
 * Standalone script to sync HOA MongoDB indexes (safe to run in CI/deploy).
 * Usage: npm run ensure:hoa-indexes
 */
require('dotenv').config();

const { connectDB, disconnectDB } = require('../src/config/db.config');
const { ensureHoaIndexes } = require('../src/common/db/ensureHoaIndexes');

async function main() {
  await connectDB();
  await ensureHoaIndexes();
  await disconnectDB();
  console.log('HOA indexes synced successfully');
}

main().catch((err) => {
  console.error('HOA index sync failed:', err);
  process.exit(1);
});
