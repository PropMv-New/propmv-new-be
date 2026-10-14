/**
 * ------------------------------------------------------------------
 * File: add-my-units-to-hoa-owner-sidebar.js
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
 * Migration: add 'my-units' to HOA Owner role sidebar
 * Run once: node scripts/add-my-units-to-hoa-owner-sidebar.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Role = mongoose.connection.collection('roles');

  const result = await Role.updateOne(
    { name: 'HOA Owner' },
    { $addToSet: { sidebar: 'my-units' } }
  );

  console.log('HOA Owner sidebar update result:', result);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
