/**
 * ------------------------------------------------------------------
 * File: check-company-roles.js
 * Module: Backend Core
 *
 * Purpose:
 * Backend utility/module providing helper functions for check-company-roles.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

require('dotenv').config({ path: '.env.local' });
const mongoose = require('mongoose');
const Company = require('./src/shared/modules/company/models/company.model');
const User = require('./src/shared/modules/users/models/user.model');

async function checkCompanyRoles() {
  try {
    await mongoose.connect(process.env.DB_URL);
    console.log('Connected to MongoDB\n');

    console.log('='.repeat(80));
    console.log('COMPANY ROLES ANALYSIS');
    console.log('='.repeat(80) + '\n');

    const companies = await Company.find({ isDeleted: { $ne: true } });

    console.log(`📊 Total Companies: ${companies.length}\n`);

    if (companies.length === 0) {
      console.log(' No companies found in the database!\n');
      console.log('💡 This is why roles are not showing in Role Management page.');
      console.log('   The /api/v1/auth/role endpoint returns company roles only.\n');
    } else {
      companies.forEach((company, index) => {
        console.log(`\n🏢 Company ${index + 1}: ${company.name}`);
        console.log(`   ID: ${company._id}`);
        console.log(`   Created: ${company.createdAt}`);

        if (!company.roles || company.roles.length === 0) {
          console.log('    No roles in this company');
        } else {
          console.log(`   📋 Roles (${company.roles.length}):`);
          company.roles.forEach(role => {
            console.log(`      - ${role.name} (ID: ${role._id}, Active: ${role.isActive})`);
            if (role.privileges && role.privileges.length > 0) {
              console.log(`        Privileges: ${role.privileges.length} assigned`);
            }
          });
        }
      });
    }

    // Check users with companies
    const usersWithCompanies = await User.find({
      companyId: { $exists: true, $ne: null },
      isDeleted: { $ne: true }
    }).select('email companyId companyRoleId').limit(5);

    console.log('\n\n👥 Sample Users with Companies:');
    console.log('-'.repeat(80));
    if (usersWithCompanies.length === 0) {
      console.log('   No users with companies found\n');
    } else {
      usersWithCompanies.forEach(user => {
        console.log(`   Email: ${user.email}`);
        console.log(`   Company ID: ${user.companyId}`);
        console.log(`   Company Role ID: ${user.companyRoleId || 'None'}\n`);
      });
    }

    console.log('='.repeat(80));
    console.log('SOLUTION:');
    console.log('='.repeat(80));
    console.log(`
The frontend needs TWO different endpoints:

1. For User Creation Dropdown:
   - Use: /api/v1/auth/signup-roles
   - Returns: PropMv company embedded roles
   - Purpose: Create users with company roles

2. For Role Management Page:
   - Use: /api/v1/auth/role
   - Returns: Company roles (embedded in companies)
   - Purpose: Manage company-specific roles

Current state: ${companies.length === 0 ? 'NO COMPANIES EXIST' : companies.length + ' companies found'}
    `);

    await mongoose.disconnect();
    console.log('\nDone!\n');
    process.exit(0);
  } catch (error) {
    console.error(' Error:', error.message);
    console.error(error.stack);
    await mongoose.disconnect();
    process.exit(1);
  }
}

checkCompanyRoles();
