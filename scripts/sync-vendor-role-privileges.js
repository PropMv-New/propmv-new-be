/**
 * Syncs the Vendor role privileges on the PropMv company.
 * Run: node scripts/sync-vendor-role-privileges.js
 */

const mongoose = require('mongoose');
const Company = require('../src/shared/modules/company/models/company.model');
const path = require('path');
const fs = require('fs');

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
else require('dotenv').config();

const VENDOR_PRIVILEGES = [
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
  'VIEW_SETTINGS',  // required for authorize on my-hoas + profile routes
];

async function run() {
  const uri = process.env.MONGODB_URI || process.env.DB_URL;
  if (!uri) { console.error('DB_URL not set'); process.exit(1); }

  await mongoose.connect(uri, { dbName: process.env.DB_NAME || 'PropMv' });
  console.log('Connected to MongoDB\n');

  const company = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });
  if (!company) { console.error('PropMv company not found'); process.exit(1); }

  const vendorRole = company.roles.find(
    (r) => r.name.toLowerCase().trim() === 'vendor' && r.isActive
  );
  if (!vendorRole) { console.error('Vendor role not found in PropMv company'); process.exit(1); }

  const current = new Set(vendorRole.privileges || []);
  const missing = VENDOR_PRIVILEGES.filter((p) => !current.has(p));

  if (!missing.length) {
    console.log(' Vendor role already has all required privileges.');
    console.log(`   Current: ${[...current].join(', ')}`);
  } else {
    vendorRole.privileges = [...current, ...missing];
    company.markModified('roles');
    await company.save();
    console.log(` Added ${missing.length} missing privilege(s) to Vendor role:`);
    console.log(`   Added: ${missing.join(', ')}`);
    console.log(`   Total: ${vendorRole.privileges.join(', ')}`);
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch((err) => { console.error(err); process.exit(1); });
