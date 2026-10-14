/**
 * Create HOA Board Member user
 * Run: node scripts/create-hoa-user.js
 *
 * Required env vars (set in .env.local):
 *   MONGODB_URI        - MongoDB connection string
 *   HOA_USER_EMAIL     - Email for the new HOA board member
 *   HOA_USER_PASSWORD  - Plain password for the new HOA board member
 *   HOA_USER_FIRST     - First name (default: HOA)
 *   HOA_USER_LAST      - Last name (default: User)
 */

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
else require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'PropMv';

if (!MONGODB_URI) {
  console.error('MONGODB_URI not set in .env.local');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });
  console.log('Connected to MongoDB\n');

  const Company = require('../src/shared/modules/company/models/company.model');
  const User = require('../src/shared/modules/users/models/user.model');
  const bcrypt = require('bcryptjs');

  // 1. Find PropMv company and HOA Board Member role
  const company = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } }).lean();
  if (!company) {
    console.error('PropMv company not found. Run create-propmv-company-with-roles.js first.');
    process.exit(1);
  }

  const hoaRole = company.roles.find((r) => r.name === 'HOA Board Member' && r.isActive);
  if (!hoaRole) {
    console.error('HOA Board Member role not found in PropMv company.');
    process.exit(1);
  }

  console.log(`Found role: ${hoaRole.name} (${hoaRole._id})`);

  // 2. Check if user already exists
  const email = process.env.HOA_USER_EMAIL;
  if (!email) {
    console.error('HOA_USER_EMAIL not set in .env.local');
    process.exit(1);
  }
  const existing = await User.findOne({ email, isDeleted: { $ne: true } }).lean();
  if (existing) {
    console.log(`User already exists: ${email}`);
    console.log(`ID: ${existing._id}`);
    await mongoose.disconnect();
    return;
  }

  // 3. Create user
  const plainPassword = process.env.HOA_USER_PASSWORD;
  if (!plainPassword) {
    console.error('HOA_USER_PASSWORD not set in .env.local');
    process.exit(1);
  }
  const hashed = await bcrypt.hash(plainPassword, 10);
  const firstName = process.env.HOA_USER_FIRST || 'HOA';
  const lastName = process.env.HOA_USER_LAST || 'User';

  const user = await User.create({
    firstName,
    lastName,
    email,
    password: hashed,
    companyId: company._id,
    companyRoleId: hoaRole._id,
    status: 'Active',
    portalOnboardingStatus: 'active',
  });

  console.log('\nHOA Board Member user created successfully!');
  console.log('Name     :', user.firstName, user.lastName);
  console.log('Email    :', user.email);
  console.log('Role     : HOA Board Member');
  console.log('User ID  :', String(user._id));

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
