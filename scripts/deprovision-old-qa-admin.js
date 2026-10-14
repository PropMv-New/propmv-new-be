/**
 * Deprovision Old Local QA Admin Account (jadeyash2812@gmail.com)
 *
 * Explicitly unlinks and removes internal Admin authorization for the previous
 * local QA user (jadeyash2812@gmail.com) from the canonical PropMv company.
 *
 * Safe and explicit:
 * - Targets ONLY jadeyash2812@gmail.com
 * - Does NOT touch customer accounts, support@propmv.com, or other QA accounts
 * - Idempotent
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

const DB_URL = process.env.DB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017/propmv';
const DB_NAME = process.env.DB_NAME || 'PropMv';
const TARGET_EMAILS = (process.env.DEPROVISION_ADMIN_EMAIL || 'jadeyash2812@gmail.com,privacy@propmv.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

async function run() {
  console.log('═'.repeat(70));
  console.log('  Deprovision Old Local QA Admin Account');
  console.log('═'.repeat(70));
  console.log(`Target Email(s): ${TARGET_EMAILS.join(', ')}`);
  console.log(`Database:        ${DB_NAME}\n`);

  await mongoose.connect(DB_URL, { dbName: DB_NAME });
  console.log('Connected to MongoDB.\n');

  const User = require('../src/shared/modules/users/models/user.model');

  const users = await User.find({ email: { $in: TARGET_EMAILS } });
  if (!users || users.length === 0) {
    console.log(`✓ No user found matching ${TARGET_EMAILS.join(', ')}. Nothing to deprovision.`);
  } else {
    console.log(`Found ${users.length} record(s) matching target emails:\n`);

    for (const user of users) {
      console.log(`Processing User ID: ${user._id}`);
      console.log(`  Previous State: isDeleted=${user.isDeleted}, status=${user.status}, lockAccount=${user.lockAccount}, companyId=${user.companyId}, role=${user.role}`);

      // Deprovision: unlink company & role, mark deleted, inactive, and locked
      user.companyId = undefined;
      user.companyRoleId = undefined;
      user.role = undefined;
      user.isDeleted = true;
      user.status = 'Inactive';
      user.lockAccount = true;
      user.mfaOtp = undefined;
      user.mfaOtpExpiresAt = undefined;
      user.mfaOtpAction = undefined;

      await user.save();
      console.log(`  ✓ Updated: isDeleted=true, status='Inactive', lockAccount=true, company unlinked\n`);
    }

    console.log(`✓ Successfully deprovisioned all (${users.length}) record(s) for ${TARGET_EMAILS.join(', ')}.`);
  }

  console.log('\nDeprovisioning Complete.');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('\nDeprovisioning failed:', err.message);
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
