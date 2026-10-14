/**
 * ------------------------------------------------------------------
 * File: create-propmv-company-with-roles.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Company = require('../src/shared/modules/company/models/company.model');
const path = require('path');
const fs = require('fs');

// Load environment
const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

// All privileges used in the application
const PRIVILEGES = {
  // Property Management
  VIEW_PROPERTY: 'VIEW_PROPERTY',
  CREATE_PROPERTY: 'CREATE_PROPERTY',
  EDIT_PROPERTY: 'EDIT_PROPERTY',
  DELETE_PROPERTY: 'DELETE_PROPERTY',

  // Tenant Management
  VIEW_TENANTS: 'VIEW_TENANTS',
  CREATE_TENANTS: 'CREATE_TENANTS',
  EDIT_TENANTS: 'EDIT_TENANTS',
  DELETE_TENANTS: 'DELETE_TENANTS',

  // Application Management
  VIEW_APPLICATION: 'VIEW_APPLICATION',
  CREATE_APPLICATION: 'CREATE_APPLICATION',
  EDIT_APPLICATION: 'EDIT_APPLICATION',
  DELETE_APPLICATION: 'DELETE_APPLICATION',

  // Lease Management
  VIEW_LEASE: 'VIEW_LEASE',
  CREATE_LEASE: 'CREATE_LEASE',
  EDIT_LEASE: 'EDIT_LEASE',
  DELETE_LEASE: 'DELETE_LEASE',

  // Income Management
  VIEW_INCOME: 'VIEW_INCOME',
  CREATE_INCOME: 'CREATE_INCOME',
  EDIT_INCOME: 'EDIT_INCOME',
  DELETE_INCOME: 'DELETE_INCOME',

  // Expense Management
  VIEW_EXPENSE: 'VIEW_EXPENSE',
  CREATE_EXPENSE: 'CREATE_EXPENSE',
  EDIT_EXPENSE: 'EDIT_EXPENSE',
  DELETE_EXPENSE: 'DELETE_EXPENSE',

  // Maintenance Management
  VIEW_MAINTENANCE: 'VIEW_MAINTENANCE',
  CREATE_MAINTENANCE: 'CREATE_MAINTENANCE',
  EDIT_MAINTENANCE: 'EDIT_MAINTENANCE',
  DELETE_MAINTENANCE: 'DELETE_MAINTENANCE',

  // Listings Management
  VIEW_LISTINGS: 'VIEW_LISTINGS',
  CREATE_LISTINGS: 'CREATE_LISTINGS',
  EDIT_LISTINGS: 'EDIT_LISTINGS',
  DELETE_LISTINGS: 'DELETE_LISTINGS',

  // Messaging
  VIEW_MESSAGE: 'VIEW_MESSAGE',
  SEND_MESSAGE: 'SEND_MESSAGE',
  VIEW_MESSAGING: 'VIEW_MESSAGING',

  // Email
  VIEW_EMAIL: 'VIEW_EMAIL',
  COMPOSE_EMAIL: 'COMPOSE_EMAIL',

  // Dashboard
  VIEW_DASHBOARD: 'VIEW_DASHBOARD',

  // Owner Management
  VIEW_OWNER: 'VIEW_OWNER',
  CREATE_OWNER: 'CREATE_OWNER',
  EDIT_OWNER: 'EDIT_OWNER',
  DELETE_OWNER: 'DELETE_OWNER',

  // Community
  VIEW_COMMUNITY: 'VIEW_COMMUNITY',
  MANAGE_COMMUNITY: 'MANAGE_COMMUNITY',

  // Documents
  VIEW_DOCUMENTS: 'VIEW_DOCUMENTS',
  CREATE_DOCUMENTS: 'CREATE_DOCUMENTS',
  EDIT_DOCUMENTS: 'EDIT_DOCUMENTS',
  DELETE_DOCUMENTS: 'DELETE_DOCUMENTS',

  // Reports
  VIEW_REPORTS: 'VIEW_REPORTS',
  EXPORT_REPORTS: 'EXPORT_REPORTS',

  // Settings
  VIEW_SETTINGS: 'VIEW_SETTINGS',
  EDIT_SETTINGS: 'EDIT_SETTINGS',

  // Users
  VIEW_USERS: 'VIEW_USERS',
  CREATE_USERS: 'CREATE_USERS',
  EDIT_USERS: 'EDIT_USERS',
  DELETE_USERS: 'DELETE_USERS',

  // Roles
  VIEW_ROLE: 'VIEW_ROLE',
  CREATE_ROLE: 'CREATE_ROLE',
  EDIT_ROLE: 'EDIT_ROLE',
  DELETE_ROLE: 'DELETE_ROLE',
  ASSIGN_ROLE: 'ASSIGN_ROLE',

  // Payment Management
  VIEW_PAYMENT_MANAGEMENT: 'VIEW_PAYMENT_MANAGEMENT',
};

// Role configurations
const ROLE_CONFIGS = {
  'Landlord': {
    description: 'Landlord user role with full property management access',
    privileges: [
      PRIVILEGES.VIEW_DASHBOARD,
      PRIVILEGES.VIEW_PROPERTY, PRIVILEGES.CREATE_PROPERTY, PRIVILEGES.EDIT_PROPERTY, PRIVILEGES.DELETE_PROPERTY,
      PRIVILEGES.VIEW_TENANTS, PRIVILEGES.CREATE_TENANTS, PRIVILEGES.EDIT_TENANTS, PRIVILEGES.DELETE_TENANTS,
      PRIVILEGES.VIEW_APPLICATION, PRIVILEGES.CREATE_APPLICATION, PRIVILEGES.EDIT_APPLICATION, PRIVILEGES.DELETE_APPLICATION,
      PRIVILEGES.VIEW_LEASE, PRIVILEGES.CREATE_LEASE, PRIVILEGES.EDIT_LEASE, PRIVILEGES.DELETE_LEASE,
      PRIVILEGES.VIEW_INCOME, PRIVILEGES.CREATE_INCOME, PRIVILEGES.EDIT_INCOME, PRIVILEGES.DELETE_INCOME,
      PRIVILEGES.VIEW_EXPENSE, PRIVILEGES.CREATE_EXPENSE, PRIVILEGES.EDIT_EXPENSE, PRIVILEGES.DELETE_EXPENSE,
      PRIVILEGES.VIEW_MAINTENANCE, PRIVILEGES.CREATE_MAINTENANCE, PRIVILEGES.EDIT_MAINTENANCE, PRIVILEGES.DELETE_MAINTENANCE,
      PRIVILEGES.VIEW_LISTINGS, PRIVILEGES.CREATE_LISTINGS, PRIVILEGES.EDIT_LISTINGS, PRIVILEGES.DELETE_LISTINGS,
      PRIVILEGES.VIEW_MESSAGE, PRIVILEGES.SEND_MESSAGE, PRIVILEGES.VIEW_MESSAGING,
      PRIVILEGES.VIEW_EMAIL, PRIVILEGES.COMPOSE_EMAIL,
      PRIVILEGES.VIEW_REPORTS, PRIVILEGES.EXPORT_REPORTS,
      PRIVILEGES.VIEW_SETTINGS, PRIVILEGES.EDIT_SETTINGS,
      PRIVILEGES.VIEW_USERS, PRIVILEGES.CREATE_USERS, PRIVILEGES.EDIT_USERS, PRIVILEGES.DELETE_USERS,
      PRIVILEGES.VIEW_PAYMENT_MANAGEMENT,
    ],
  },
  'Tenant': {
    description: 'Tenant user role with limited access',
    privileges: [
      PRIVILEGES.VIEW_DASHBOARD,
      PRIVILEGES.VIEW_LEASE,
      PRIVILEGES.VIEW_MAINTENANCE, PRIVILEGES.CREATE_MAINTENANCE,
      PRIVILEGES.VIEW_MESSAGE, PRIVILEGES.SEND_MESSAGE, PRIVILEGES.VIEW_MESSAGING,
      PRIVILEGES.VIEW_DOCUMENTS,
      PRIVILEGES.VIEW_SETTINGS,
    ],
  },
  'Property Manager': {
    description: 'Property manager user role with comprehensive management access',
    privileges: [
      PRIVILEGES.VIEW_DASHBOARD,
      PRIVILEGES.VIEW_PROPERTY, PRIVILEGES.CREATE_PROPERTY, PRIVILEGES.EDIT_PROPERTY, PRIVILEGES.DELETE_PROPERTY,
      PRIVILEGES.VIEW_TENANTS, PRIVILEGES.CREATE_TENANTS, PRIVILEGES.EDIT_TENANTS, PRIVILEGES.DELETE_TENANTS,
      PRIVILEGES.VIEW_APPLICATION, PRIVILEGES.CREATE_APPLICATION, PRIVILEGES.EDIT_APPLICATION, PRIVILEGES.DELETE_APPLICATION,
      PRIVILEGES.VIEW_LEASE, PRIVILEGES.CREATE_LEASE, PRIVILEGES.EDIT_LEASE, PRIVILEGES.DELETE_LEASE,
      PRIVILEGES.VIEW_INCOME, PRIVILEGES.CREATE_INCOME, PRIVILEGES.EDIT_INCOME, PRIVILEGES.DELETE_INCOME,
      PRIVILEGES.VIEW_EXPENSE, PRIVILEGES.CREATE_EXPENSE, PRIVILEGES.EDIT_EXPENSE, PRIVILEGES.DELETE_EXPENSE,
      PRIVILEGES.VIEW_MAINTENANCE, PRIVILEGES.CREATE_MAINTENANCE, PRIVILEGES.EDIT_MAINTENANCE, PRIVILEGES.DELETE_MAINTENANCE,
      PRIVILEGES.VIEW_LISTINGS, PRIVILEGES.CREATE_LISTINGS, PRIVILEGES.EDIT_LISTINGS, PRIVILEGES.DELETE_LISTINGS,
      PRIVILEGES.VIEW_MESSAGE, PRIVILEGES.SEND_MESSAGE, PRIVILEGES.VIEW_MESSAGING,
      PRIVILEGES.VIEW_EMAIL, PRIVILEGES.COMPOSE_EMAIL,
      PRIVILEGES.VIEW_REPORTS, PRIVILEGES.EXPORT_REPORTS,
      PRIVILEGES.VIEW_SETTINGS, PRIVILEGES.EDIT_SETTINGS,
      PRIVILEGES.VIEW_USERS, PRIVILEGES.CREATE_USERS, PRIVILEGES.EDIT_USERS, PRIVILEGES.DELETE_USERS,
      PRIVILEGES.VIEW_ROLE, PRIVILEGES.CREATE_ROLE, PRIVILEGES.EDIT_ROLE, PRIVILEGES.DELETE_ROLE, PRIVILEGES.ASSIGN_ROLE,
      PRIVILEGES.VIEW_PAYMENT_MANAGEMENT,
    ],
  },
  'HOA Board Member': {
    description: 'HOA board member role with HOA management access',
    privileges: [
      PRIVILEGES.VIEW_DASHBOARD,
      PRIVILEGES.VIEW_PROPERTY, PRIVILEGES.CREATE_PROPERTY, PRIVILEGES.EDIT_PROPERTY, PRIVILEGES.DELETE_PROPERTY,
      PRIVILEGES.VIEW_OWNER, PRIVILEGES.CREATE_OWNER, PRIVILEGES.EDIT_OWNER, PRIVILEGES.DELETE_OWNER,
      PRIVILEGES.VIEW_INCOME, PRIVILEGES.CREATE_INCOME, PRIVILEGES.EDIT_INCOME, PRIVILEGES.DELETE_INCOME,
      PRIVILEGES.VIEW_EXPENSE, PRIVILEGES.CREATE_EXPENSE, PRIVILEGES.EDIT_EXPENSE, PRIVILEGES.DELETE_EXPENSE,
      PRIVILEGES.VIEW_MAINTENANCE, PRIVILEGES.CREATE_MAINTENANCE, PRIVILEGES.EDIT_MAINTENANCE, PRIVILEGES.DELETE_MAINTENANCE,
      PRIVILEGES.VIEW_MESSAGE, PRIVILEGES.SEND_MESSAGE, PRIVILEGES.VIEW_MESSAGING,
      PRIVILEGES.VIEW_EMAIL, PRIVILEGES.COMPOSE_EMAIL,
      PRIVILEGES.VIEW_COMMUNITY, PRIVILEGES.MANAGE_COMMUNITY,
      PRIVILEGES.VIEW_DOCUMENTS, PRIVILEGES.CREATE_DOCUMENTS, PRIVILEGES.EDIT_DOCUMENTS, PRIVILEGES.DELETE_DOCUMENTS,
      PRIVILEGES.VIEW_REPORTS, PRIVILEGES.EXPORT_REPORTS,
      PRIVILEGES.VIEW_SETTINGS, PRIVILEGES.EDIT_SETTINGS,
    ],
  },
  'HOA Owner': {
    description: 'HOA property owner role with limited access',
    privileges: [
      PRIVILEGES.VIEW_DASHBOARD,
      PRIVILEGES.VIEW_DOCUMENTS,
      PRIVILEGES.CREATE_DOCUMENTS,
      PRIVILEGES.EDIT_DOCUMENTS,
      PRIVILEGES.DELETE_DOCUMENTS,
      PRIVILEGES.VIEW_INCOME,
      PRIVILEGES.VIEW_MAINTENANCE, PRIVILEGES.CREATE_MAINTENANCE, PRIVILEGES.EDIT_MAINTENANCE,
      PRIVILEGES.VIEW_MESSAGE, PRIVILEGES.SEND_MESSAGE, PRIVILEGES.VIEW_MESSAGING,
      PRIVILEGES.VIEW_EMAIL, PRIVILEGES.COMPOSE_EMAIL,
      PRIVILEGES.VIEW_REPORTS,
      PRIVILEGES.VIEW_SETTINGS,
    ],
  },
  'Vendor': {
    description: 'Vendor / contractor portal role for assigned maintenance work and billing',
    privileges: [
      PRIVILEGES.VIEW_DASHBOARD,
      PRIVILEGES.VIEW_INCOME, PRIVILEGES.CREATE_INCOME, PRIVILEGES.EDIT_INCOME,
      PRIVILEGES.VIEW_MAINTENANCE, PRIVILEGES.EDIT_MAINTENANCE,
      PRIVILEGES.VIEW_MESSAGE, PRIVILEGES.SEND_MESSAGE, PRIVILEGES.VIEW_MESSAGING,
      PRIVILEGES.VIEW_EMAIL, PRIVILEGES.COMPOSE_EMAIL,
      PRIVILEGES.VIEW_SETTINGS,
    ],
  },
};

async function createPropMvCompany() {
  try {
    console.log('═'.repeat(70));
    console.log('  Create PropMv Company with Roles and Privileges');
    console.log('═'.repeat(70));
    console.log('');

    // Connect to database
    const mongoUri = process.env.MONGODB_URI || process.env.DB_URL || 'mongodb://localhost:27017/propmv';
    console.log(`📡 Connecting to MongoDB...`);

    await mongoose.connect(mongoUri, {
      dbName: process.env.DB_NAME || 'PropMv'
    });
    console.log('Connected to MongoDB\n');

    // Check if PropMv company already exists
    const existingCompany = await Company.findOne({ name: 'PropMv', isDeleted: { $ne: true } });

    if (existingCompany) {
      console.log('⚠️  PropMv company already exists!');
      console.log(`   Company ID: ${existingCompany._id}`);
      console.log(`   Roles: ${existingCompany.roles.length}\n`);

      // Ensure roles include latest privileges; add any missing role configs (e.g. Vendor)
      let privilegesUpdated = false;
      const existingNames = new Set((existingCompany.roles || []).map((r) => r.name));
      for (const [name, config] of Object.entries(ROLE_CONFIGS)) {
        if (!existingNames.has(name)) {
          existingCompany.roles.push({
            name,
            description: config.description,
            privileges: config.privileges,
            isActive: true,
          });
          privilegesUpdated = true;
          console.log(`   ✓ Added missing role: ${name} (${config.privileges.length} privileges)`);
        }
      }
      for (const role of existingCompany.roles) {
        const config = ROLE_CONFIGS[role.name];
        if (!config) continue;
        const current = new Set(role.privileges || []);
        const missing = config.privileges.filter((p) => !current.has(p));
        if (missing.length) {
          role.privileges = [...current, ...missing];
          privilegesUpdated = true;
          console.log(`   ✓ Synced ${missing.length} missing privilege(s) onto ${role.name}: ${missing.join(', ')}`);
        }
      }

      if (privilegesUpdated) {
        existingCompany.markModified('roles');
        await existingCompany.save();
        console.log('\nUpdated existing PropMv company role privileges.\n');
      } else {
        existingCompany.roles.forEach((role, index) => {
          console.log(`   ${index + 1}. ${role.name} - ${role.privileges.length} privileges`);
        });
        console.log('\n💡 Roles already up to date. To recreate, delete the existing company first.\n');
      }

      await mongoose.disconnect();
      process.exit(0);
    }

    // Create embedded roles
    console.log('🔧 Creating roles with privileges...\n');
    const embeddedRoles = Object.entries(ROLE_CONFIGS).map(([name, config]) => {
      console.log(`   ✓ ${name}: ${config.privileges.length} privileges`);
      return {
        name,
        description: config.description,
        privileges: config.privileges,
        isActive: true,
      };
    });

    console.log('');

    // Create PropMv company
    console.log('🏢 Creating PropMv company...');
    const company = await Company.create({
      name: 'PropMv',
      description: 'Default company for PropMv platform',
      roles: embeddedRoles,
      isActive: true,
      isDeleted: false,
      contactInfo: {
        email: 'support@propmv.com',
        website: 'https://propmv.com'
      },
      settings: {
        timezone: 'America/New_York',
        currency: 'USD',
        dateFormat: 'MM/DD/YYYY'
      },
      subscription: {
        plan: 'enterprise',
        status: 'active',
        startDate: new Date()
      }
    });

    console.log('PropMv company created successfully!\n');

    // Display summary
    console.log('═'.repeat(70));
    console.log('  Summary');
    console.log('═'.repeat(70));
    console.log(`\nCompany ID: ${company._id}`);
    console.log(`Company Name: ${company.name}`);
    console.log(`Total Roles: ${company.roles.length}\n`);

    console.log('Roles and Privileges:\n');
    company.roles.forEach((role, index) => {
      console.log(`${index + 1}. ${role.name}`);
      console.log(`   Role ID: ${role._id}`);
      console.log(`   Description: ${role.description}`);
      console.log(`   Privileges: ${role.privileges.length}`);
      console.log(`   Active: ${role.isActive}\n`);
    });

    console.log('═'.repeat(70));
    console.log('Setup completed successfully!');
    console.log('═'.repeat(70));
    console.log('');

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB\n');
    process.exit(0);
  } catch (error) {
    console.error('\n Error:', error.message);
    console.error(error.stack);

    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }

    process.exit(1);
  }
}

createPropMvCompany();
