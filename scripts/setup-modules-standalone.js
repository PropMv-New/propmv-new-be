/**
 * ------------------------------------------------------------------
 * File: setup-modules-standalone.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Standalone script to insert modules with their functions into the database
 * This script can be run directly without .env file
 * 
 * Usage: node scripts/setup-modules-standalone.js
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

// MongoDB Connection String loaded from .env.local
const MONGODB_URI = process.env.MONGODB_URI;

// Module Schema
const moduleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String },
    functions: [{ type: String, trim: true }],
  },
  { timestamps: true }
);

const Module = mongoose.models.Module || mongoose.model('Module', moduleSchema);

// All privileges from the system
const privileges = [
  "VIEW_PROPERTY",
  "CREATE_PROPERTY",
  "EDIT_PROPERTY",
  "DELETE_PROPERTY",
  "VIEW_TENANTS",
  "CREATE_TENANTS",
  "EDIT_TENANTS",
  "DELETE_TENANTS",
  "VIEW_APPLICATION",
  "CREATE_APPLICATION",
  "EDIT_APPLICATION",
  "DELETE_APPLICATION",
  "VIEW_LEASE",
  "CREATE_LEASE",
  "EDIT_LEASE",
  "DELETE_LEASE",
  "VIEW_INCOME",
  "CREATE_INCOME",
  "EDIT_INCOME",
  "DELETE_INCOME",
  "VIEW_EXPENSE",
  "CREATE_EXPENSE",
  "EDIT_EXPENSE",
  "DELETE_EXPENSE",
  "VIEW_MAINTENANCE",
  "CREATE_MAINTENANCE",
  "EDIT_MAINTENANCE",
  "DELETE_MAINTENANCE",
  "VIEW_LISTINGS",
  "CREATE_LISTINGS",
  "EDIT_LISTINGS",
  "DELETE_LISTINGS",
  "VIEW_MESSAGE",
  "SEND_MESSAGE",
  "VIEW_EMAIL",
  "COMPOSE_EMAIL",
  "VIEW_DASHBOARD",
  "VIEW_USERS",
  "CREATE_USERS",
  "EDIT_USERS",
  "DELETE_USERS",
  "VIEW_ROLE",
  "CREATE_ROLE",
  "EDIT_ROLE",
  "DELETE_ROLE",
  "ASSIGN_ROLE"
];

// Module descriptions
const moduleDescriptions = {
  'PROPERTY': 'Property management module - manage properties, units, and property details',
  'TENANTS': 'Tenant management module - manage tenant information and relationships',
  'APPLICATION': 'Application management module - handle rental applications',
  'LEASE': 'Lease management module - manage lease agreements and terms',
  'INCOME': 'Income management module - track rental income and payments',
  'EXPENSE': 'Expense management module - track property expenses and bills',
  'MAINTENANCE': 'Maintenance management module - handle maintenance requests and work orders',
  'LISTINGS': 'Listings management module - manage property listings and advertisements',
  'MESSAGE': 'Messaging module - internal messaging and communication',
  'EMAIL': 'Email module - email communication and notifications',
  'DASHBOARD': 'Dashboard module - view dashboard and analytics',
  'USERS': 'User management module - manage system users',
  'ROLE': 'Role management module - manage roles and permissions',
};

/**
 * Parse privileges and group by module
 */
function parsePrivileges(privileges) {
  const moduleMap = new Map();

  for (const privilege of privileges) {
    const parts = privilege.split('_');

    if (parts.length < 2) {
      console.warn(`⚠️  Skipping invalid privilege: ${privilege}`);
      continue;
    }

    const func = parts[0];
    const moduleName = parts.slice(1).join('_');

    if (!moduleMap.has(moduleName)) {
      moduleMap.set(moduleName, new Set());
    }

    moduleMap.get(moduleName).add(func);
  }

  return moduleMap;
}

/**
 * Main setup function
 */
async function setupModules() {
  let connection;

  try {
    console.log('\n' + '═'.repeat(80));
    console.log('🚀 MODULE SETUP SCRIPT');
    console.log('═'.repeat(80) + '\n');

    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    if (!MONGODB_URI) throw new Error('MONGODB_URI is not set in .env.local');
    connection = await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB successfully\n');

    // Parse privileges
    console.log('📊 Parsing privileges...');
    const moduleMap = parsePrivileges(privileges);
    console.log(`Found ${moduleMap.size} unique modules\n`);

    // Prepare module documents
    const moduleDocs = [];
    console.log('📝 Modules to be created:');
    console.log('─'.repeat(80));

    for (const [moduleName, functions] of moduleMap.entries()) {
      const functionsArray = Array.from(functions).sort();
      const doc = {
        name: moduleName,
        description: moduleDescriptions[moduleName] || `${moduleName} module`,
        functions: functionsArray,
      };
      moduleDocs.push(doc);

      console.log(`\n📦 ${moduleName}`);
      console.log(`   Functions (${functionsArray.length}): ${functionsArray.join(', ')}`);
    }
    console.log('\n' + '─'.repeat(80) + '\n');

    // Clear existing modules
    console.log('🗑️  Clearing existing modules...');
    const deleteResult = await Module.deleteMany({});
    console.log(`Deleted ${deleteResult.deletedCount} existing modules\n`);

    // Insert new modules
    console.log('💾 Inserting modules into database...');
    const insertedModules = await Module.insertMany(moduleDocs);
    console.log(`Successfully inserted ${insertedModules.length} modules\n`);

    // Verify
    console.log('🔍 Verifying inserted data...');
    const allModules = await Module.find().sort({ name: 1 });

    console.log('\n' + '═'.repeat(80));
    console.log('📊 VERIFICATION RESULTS');
    console.log('═'.repeat(80) + '\n');

    for (const module of allModules) {
      console.log(`✓ ${module.name}`);
      console.log(`  ID: ${module._id}`);
      console.log(`  Functions: ${module.functions.join(', ')}`);
      console.log('');
    }

    // Generate all possible privileges
    const generatedPrivileges = [];
    for (const module of allModules) {
      for (const func of module.functions) {
        generatedPrivileges.push(`${func}_${module.name}`);
      }
    }
    generatedPrivileges.sort();

    console.log('═'.repeat(80));
    console.log('📈 STATISTICS');
    console.log('═'.repeat(80));
    console.log(`Modules created: ${allModules.length}`);
    console.log(`Total privileges: ${generatedPrivileges.length}`);
    console.log(`Original privileges: ${privileges.length}`);
    console.log(`Match: ${generatedPrivileges.length === privileges.length ? 'YES' : ' NO'}`);
    console.log('═'.repeat(80) + '\n');

    if (generatedPrivileges.length === privileges.length) {
      console.log('🎉 SUCCESS! All modules created correctly!\n');
    } else {
      console.log('⚠️  WARNING: Privilege count mismatch!\n');
    }

  } catch (error) {
    console.error('\n ERROR:', error.message);
    console.error(error);
    throw error;
  } finally {
    if (connection) {
      await mongoose.connection.close();
      console.log('👋 Database connection closed\n');
    }
  }
}

// Run the script
setupModules()
  .then(() => {
    console.log('Script completed successfully\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error(' Script failed\n');
    process.exit(1);
  });
