/**
 * Migration: Remove VIEW_PROPERTY and VIEW_OWNER privileges from the Vendor role.
 * Run once against the live database:
 *   node scripts/remove-vendor-property-owner-privileges.js
 */

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const Company = require('../src/shared/modules/company/models/company.model');

const PRIVILEGES_TO_REMOVE = ['VIEW_PROPERTY', 'VIEW_OWNER'];

async function run() {
  const mongoUri = process.env.MONGODB_URI || process.env.DB_URL || 'mongodb://localhost:27017/propmv';
  console.log('📡 Connecting to MongoDB...');
  await mongoose.connect(mongoUri, { dbName: process.env.DB_NAME || 'PropMv' });
  console.log(' Connected\n');

  const companies = await Company.find({ 'roles.name': 'Vendor', isDeleted: { $ne: true } });

  if (!companies.length) {
    console.log('ℹ️  No companies with a Vendor role found.');
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const company of companies) {
    const vendorRole = company.roles.find((r) => r.name === 'Vendor' && r.isActive);
    if (!vendorRole) continue;

    const before = vendorRole.privileges.length;
    vendorRole.privileges = vendorRole.privileges.filter((p) => !PRIVILEGES_TO_REMOVE.includes(p));
    const removed = before - vendorRole.privileges.length;

    if (removed > 0) {
      company.markModified('roles');
      await company.save();
      console.log(` Company "${company.name}" (${company._id}): removed ${removed} privilege(s) from Vendor role.`);
    } else {
      console.log(`ℹ️  Company "${company.name}": Vendor role already does not have those privileges.`);
    }
  }

  await mongoose.disconnect();
  console.log('\n Migration complete.');
  process.exit(0);
}

run().catch((err) => {
  console.error(' Migration failed:', err.message);
  process.exit(1);
});
