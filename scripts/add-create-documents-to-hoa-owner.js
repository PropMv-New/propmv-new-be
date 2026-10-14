/**
 * Migration: grant CREATE_DOCUMENTS to HOA Owner role (required for document upload).
 * Run once: node scripts/add-create-documents-to-hoa-owner.js
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Company = require('../src/shared/modules/company/models/company.model');

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const PRIVILEGES_TO_ADD = ['CREATE_DOCUMENTS', 'EDIT_DOCUMENTS', 'DELETE_DOCUMENTS'];

async function run() {
  const mongoUri = process.env.MONGODB_URI || process.env.DB_URL || 'mongodb://localhost:27017/propmv';
  await mongoose.connect(mongoUri, { dbName: process.env.DB_NAME || 'PropMv' });

  const company = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });
  if (!company) {
    console.error('PropMv company not found');
    process.exit(1);
  }

  const role = company.roles.find((r) => r.name === 'HOA Owner' && r.isActive !== false);
  if (!role) {
    console.error('HOA Owner role not found in PropMv company');
    process.exit(1);
  }

  const privileges = new Set(role.privileges || []);
  const missing = PRIVILEGES_TO_ADD.filter((privilege) => !privileges.has(privilege));
  if (missing.length === 0) {
    console.log('HOA Owner already has document upload/edit/delete privileges');
    await mongoose.disconnect();
    return;
  }

  role.privileges = [...privileges, ...missing];
  company.markModified('roles');
  await company.save();

  console.log(`Added ${missing.join(', ')} to HOA Owner role (${role.privileges.length} privileges total)`);
  console.log('Users must re-login or refresh their token to pick up the new privilege.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
