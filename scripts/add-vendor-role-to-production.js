/**
 * Adds the Vendor role to the PropMv company in the target database.
 * Targets: mongodb+srv://support_db_user:...@propmv.nghqvlv.mongodb.net/PropMv
 *
 * Safe to run multiple times - skips if Vendor role already exists and is up to date.
 *
 * Run: node scripts/add-vendor-role-to-production.js
 */

'use strict';

const mongoose = require('mongoose');

// ── Target DB (the one you specified) ────────────────────────────────────────
const TARGET_DB_URL =
  'mongodb+srv://support_db_user:bCmGvGJJBywa9itS@propmv.nghqvlv.mongodb.net/?appName=PropMv';
const TARGET_DB_NAME = 'PropMv';

// ── Exact Vendor role definition from create-propmv-company-with-roles.js ────
const VENDOR_ROLE = {
  name: 'Vendor',
  description: 'Vendor / contractor portal role for assigned maintenance work and billing',
  privileges: [
    'VIEW_DASHBOARD',
    'VIEW_INCOME',
    'CREATE_INCOME',
    'EDIT_INCOME',
    'VIEW_MAINTENANCE',
    'EDIT_MAINTENANCE',
    'VIEW_MESSAGE',
    'SEND_MESSAGE',
    'VIEW_MESSAGING',
    'VIEW_EMAIL',
    'COMPOSE_EMAIL',
    'VIEW_SETTINGS',
  ],
  isActive: true,
};

// ── Inline Company model (avoids path-resolution issues when run standalone) ─
const embeddedRoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    privileges: [{ type: String }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    roles: [embeddedRoleSchema],
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const Company =
  mongoose.models.Company || mongoose.model('Company', companySchema);

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('═'.repeat(60));
  console.log('  Add Vendor Role → PropMv (propmv.nghqvlv cluster)');
  console.log('═'.repeat(60));

  console.log('\n📡 Connecting to MongoDB…');
  await mongoose.connect(TARGET_DB_URL, { dbName: TARGET_DB_NAME });
  console.log(`✓ Connected  (db: ${TARGET_DB_NAME})\n`);

  // ── Find the PropMv company ───────────────────────────────────────────────
  const company = await Company.findOne({
    name: 'PropMv',
    isDeleted: { $ne: true },
  });

  if (!company) {
    console.error('  PropMv company document not found in this database.');
    console.error('    Make sure you are pointing at the correct cluster/db.');
    process.exit(1);
  }

  console.log(`✓ Found PropMv company  (id: ${company._id})`);
  console.log(`  Existing roles: ${company.roles.map((r) => r.name).join(', ')}\n`);

  // ── Check whether Vendor role already exists ──────────────────────────────
  const existing = company.roles.find(
    (r) => r.name.toLowerCase().trim() === 'vendor'
  );

  if (existing) {
    // Role exists - make sure it is active and has all required privileges
    const current = new Set(existing.privileges || []);
    const missing = VENDOR_ROLE.privileges.filter((p) => !current.has(p));
    let changed = false;

    if (!existing.isActive) {
      existing.isActive = true;
      changed = true;
      console.log('  ⚠️  Vendor role was inactive - re-activating.');
    }

    if (missing.length) {
      existing.privileges = [...current, ...missing];
      changed = true;
      console.log(`  ⚠️  Adding ${missing.length} missing privilege(s): ${missing.join(', ')}`);
    }

    if (changed) {
      company.markModified('roles');
      await company.save();
      console.log('\n  Vendor role updated successfully.\n');
    } else {
      console.log('  Vendor role already exists and is fully up to date. Nothing to do.\n');
    }
  } else {
    // Role does not exist - add it
    company.roles.push(VENDOR_ROLE);
    company.markModified('roles');
    await company.save();
    console.log('  Vendor role added successfully.\n');
  }

  // ── Print final state of the Vendor role ─────────────────────────────────
  const saved = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });
  const vendorRole = saved.roles.find(
    (r) => r.name.toLowerCase().trim() === 'vendor'
  );

  console.log('─'.repeat(60));
  console.log('  Vendor Role - Final State');
  console.log('─'.repeat(60));
  console.log(`  Role ID    : ${vendorRole._id}`);
  console.log(`  Name       : ${vendorRole.name}`);
  console.log(`  Description: ${vendorRole.description}`);
  console.log(`  Active     : ${vendorRole.isActive}`);
  console.log(`  Privileges (${vendorRole.privileges.length}):`);
  vendorRole.privileges.forEach((p) => console.log(`    • ${p}`));
  console.log('─'.repeat(60));

  await mongoose.disconnect();
  console.log('\n✓ Disconnected from MongoDB');
  console.log('\nDone.\n');
}

run().catch((err) => {
  console.error('\n  Script failed:', err.message || err);
  mongoose.disconnect().finally(() => process.exit(1));
});
