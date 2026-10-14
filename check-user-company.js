/**
 * ------------------------------------------------------------------
 * File: check-user-company.js
 * Module: Backend Core
 *
 * Purpose:
 * Backend utility/module providing helper functions for check-user-company.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

require('dotenv').config({ path: '.env.local' });
const mongoose = require('mongoose');
const User = require('./src/shared/modules/users/models/user.model');
const Company = require('./src/shared/modules/company/models/company.model');

async function checkUserCompanyStructure() {
  try {
    await mongoose.connect(process.env.DB_URL);
    console.log('Connected to MongoDB\n');

    // Check users with companies
    const usersWithCompany = await User.find({
      companyId: { $exists: true, $ne: null },
      isDeleted: { $ne: true }
    }).select('email companyId role').limit(5);

    console.log('👥 Users with Company:\n');
    for (const user of usersWithCompany) {
      console.log(`Email: ${user.email}`);
      console.log(`Company ID: ${user.companyId}`);
      console.log(`Global Role ID: ${user.role}`);

      if (user.companyId) {
        const company = await Company.findById(user.companyId);
        if (company) {
          console.log(`Company Name: ${company.name}`);
          console.log(`Company Roles:`);
          company.roles.filter(r => r.isActive).forEach(role => {
            console.log(`  - ${role.name} (${role._id})`);
          });
        }
      }
      console.log('');
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

checkUserCompanyStructure();
