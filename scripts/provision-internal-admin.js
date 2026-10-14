/**
 * Production Provisioning Script: Internal PropMv Platform Administrator
 *
 * Usage:
 *   ADMIN_PASSWORD="<strong-password>" node scripts/provision-internal-admin.js
 *
 * Required env:
 *   DB_URL or MONGODB_URI
 *   ADMIN_PASSWORD (minimum 8 characters; supplied at runtime, never hardcoded)
 *
 * Optional env:
 *   DB_NAME (default: PropMv)
 *   ADMIN_EMAIL (default: admin@propmv.com)
 *
 * This script is idempotent and safe:
 * - Ensures canonical PropMv internal company exists
 * - Ensures embedded 'Administrator' role with 'VIEW_INTERNAL_REPORTS' exists in PropMv company
 * - Upserts dedicated internal admin user linked to canonical PropMv company and Administrator role
 * - Does NOT modify any customer accounts, customer company roles, or support@propmv.com
 */

'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
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
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@propmv.com').trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD;

if (!PASSWORD || typeof PASSWORD !== 'string' || PASSWORD.trim().length < 8) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is required and must be at least 8 characters.');
  process.exit(1);
}

const INTERNAL_ROLE_NAME = 'Administrator';
const INTERNAL_PRIVILEGES = ['VIEW_INTERNAL_REPORTS'];

async function run() {
  console.log('═'.repeat(70));
  console.log('  Provision Canonical Internal Admin Account');
  console.log('═'.repeat(70));
  console.log(`Target Email: ${ADMIN_EMAIL}`);
  console.log(`Database:     ${DB_NAME}\n`);

  await mongoose.connect(DB_URL, { dbName: DB_NAME });
  console.log('Connected to MongoDB.\n');

  const Company = require('../src/shared/modules/company/models/company.model');
  const User = require('../src/shared/modules/users/models/user.model');

  // 1. Locate canonical PropMv internal company
  const propMvCompany = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });
  if (!propMvCompany) {
    console.error('ERROR: Canonical PropMv company not found. Database must be initialized first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`✓ Canonical PropMv Company found: ${propMvCompany.name} (ID: ${propMvCompany._id})`);

  // 2. Ensure embedded Administrator role with VIEW_INTERNAL_REPORTS in PropMv company
  if (!Array.isArray(propMvCompany.roles)) {
    propMvCompany.roles = [];
  }

  let adminRole = propMvCompany.roles.find(
    (r) => r.name.toLowerCase() === INTERNAL_ROLE_NAME.toLowerCase() && r.isActive
  );

  let companyUpdated = false;

  if (!adminRole) {
    const newRole = {
      _id: new mongoose.Types.ObjectId(),
      name: INTERNAL_ROLE_NAME,
      description: 'Internal PropMv platform administrator for system reporting and operations',
      privileges: INTERNAL_PRIVILEGES,
      isActive: true,
    };
    propMvCompany.roles.push(newRole);
    adminRole = propMvCompany.roles[propMvCompany.roles.length - 1];
    companyUpdated = true;
    console.log(`✓ Created embedded '${INTERNAL_ROLE_NAME}' role with privileges: [${INTERNAL_PRIVILEGES.join(', ')}]`);
  } else {
    // Ensure all required internal privileges are present
    const currentPrivs = new Set((adminRole.privileges || []).map((p) => String(p).toUpperCase()));
    const missingPrivs = INTERNAL_PRIVILEGES.filter((p) => !currentPrivs.has(p.toUpperCase()));
    if (missingPrivs.length > 0) {
      adminRole.privileges = [...(adminRole.privileges || []), ...missingPrivs];
      companyUpdated = true;
      console.log(`✓ Added missing privileges to existing role: [${missingPrivs.join(', ')}]`);
    } else {
      console.log(`✓ Embedded '${adminRole.name}' role already has required privileges.`);
    }
  }

  if (companyUpdated) {
    propMvCompany.markModified('roles');
    await propMvCompany.save();
    console.log('✓ PropMv company roles persisted.');
  }

  // 3. Upsert dedicated internal admin user
  const hashedPassword = await bcrypt.hash(PASSWORD, 10);
  let user = await User.findOne({ email: ADMIN_EMAIL, isDeleted: { $ne: true } });

  const accountFields = {
    email: ADMIN_EMAIL,
    firstName: 'Admin',
    lastName: 'PropMv',
    phone: '+12025550198',
    status: 'Active',
    portalOnboardingStatus: 'active',
    emailVerifiedAt: new Date(),
    lockAccount: false,
    failedLoginAttempts: 0,
    lockUntil: null,
    mfaOtp: undefined,
    mfaOtpExpiresAt: undefined,
    mfaOtpAction: undefined,
    companyId: propMvCompany._id,
    companyRoleId: adminRole._id,
    password: hashedPassword,
  };

  if (!user) {
    user = await User.create(accountFields);
    console.log(`\n✓ Created dedicated internal admin user: ${ADMIN_EMAIL}`);
  } else {
    Object.assign(user, accountFields);
    await user.save();
    console.log(`\n✓ Updated existing user: ${ADMIN_EMAIL} with canonical PropMv admin role`);
  }

  // 4. Deprovision previous admin identity (privacy@propmv.com) if different from ADMIN_EMAIL
  if (ADMIN_EMAIL !== 'privacy@propmv.com') {
    const oldUsers = await User.find({ email: 'privacy@propmv.com' });
    for (const oldUser of oldUsers) {
      if (String(oldUser.companyId) === String(propMvCompany._id) || oldUser.companyRoleId) {
        oldUser.companyId = undefined;
        oldUser.companyRoleId = undefined;
        oldUser.role = undefined;
        oldUser.isDeleted = true;
        oldUser.status = 'Inactive';
        oldUser.lockAccount = true;
        oldUser.mfaOtp = undefined;
        oldUser.mfaOtpExpiresAt = undefined;
        oldUser.mfaOtpAction = undefined;
        await oldUser.save();
        console.log(`✓ Deprovisioned former admin identity: privacy@propmv.com (${oldUser._id})`);
      }
    }
  }

  console.log('\nAccount Summary:');
  console.log(`  User ID:        ${user._id}`);
  console.log(`  Email:          ${user.email}`);
  console.log(`  Company:        ${propMvCompany.name} (${user.companyId})`);
  console.log(`  Company Role:   ${adminRole.name} (${user.companyRoleId})`);
  console.log(`  Privileges:     ${adminRole.privileges.join(', ')}`);
  console.log(`  Status:         ${user.status}`);
  console.log('\nProvisioning Complete.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('\nProvisioning failed:', err.message);
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
  process.exit(1);
});
