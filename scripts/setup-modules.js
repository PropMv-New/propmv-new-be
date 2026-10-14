/**
 * Script to insert modules with their functions into the database
 * This script parses privileges and creates module documents with associated functions
 * 
 * Usage: node scripts/setup-modules.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

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

/**
 * Parse privileges and group by module
 * Format: FUNCTION_MODULE
 * Example: VIEW_PROPERTY -> { module: 'PROPERTY', function: 'VIEW' }
 */
function parsePrivileges(privileges) {
  const moduleMap = new Map();

  for (const privilege of privileges) {
    // Split by underscore to get function and module
    const parts = privilege.split('_');

    if (parts.length < 2) {
      console.warn(`⚠️  Skipping invalid privilege format: ${privilege}`);
      continue;
    }

    // First part is the function, rest is the module name
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
 * Get module description based on module name
 */
function getModuleDescription(moduleName) {
  const descriptions = {
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

  return descriptions[moduleName] || `${moduleName} module`;
}

/**
 * Main function to setup modules
 */
async function setupModules() {
  try {
    console.log('🚀 Starting module setup...\n');

    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://support_db_user:Propmv%402024@cluster0.9qkrxlz.mongodb.net/?appName=Cluster0';

    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB\n');

    // Parse privileges to get modules and their functions
    console.log('📊 Parsing privileges...');
    const moduleMap = parsePrivileges(privileges);
    console.log(`Found ${moduleMap.size} unique modules\n`);

    // Prepare module documents
    const moduleDocs = [];
    for (const [moduleName, functions] of moduleMap.entries()) {
      const functionsArray = Array.from(functions).sort();
      moduleDocs.push({
        name: moduleName,
        description: getModuleDescription(moduleName),
        functions: functionsArray,
      });
    }

    console.log('📝 Modules to be created:');
    console.log('─'.repeat(80));
    for (const doc of moduleDocs) {
      console.log(`\n📦 Module: ${doc.name}`);
      console.log(`   Description: ${doc.description}`);
      console.log(`   Functions: ${doc.functions.join(', ')}`);
    }
    console.log('\n' + '─'.repeat(80) + '\n');

    // Clear existing modules (optional - comment out if you want to keep existing data)
    console.log('🗑️  Clearing existing modules...');
    const deleteResult = await Module.deleteMany({});
    console.log(`Deleted ${deleteResult.deletedCount} existing modules\n`);

    // Insert modules
    console.log('💾 Inserting modules into database...');
    const insertedModules = await Module.insertMany(moduleDocs);
    console.log(`Successfully inserted ${insertedModules.length} modules\n`);

    // Display summary
    console.log('📋 Summary:');
    console.log('─'.repeat(80));
    for (const module of insertedModules) {
      console.log(`✓ ${module.name}: ${module.functions.length} functions`);
    }
    console.log('─'.repeat(80) + '\n');

    // Verify the data
    console.log('🔍 Verifying inserted data...');
    const allModules = await Module.find().sort({ name: 1 });
    console.log(`Verification complete: ${allModules.length} modules found in database\n`);

    // Display detailed verification
    console.log('📊 Detailed Module Information:');
    console.log('═'.repeat(80));
    for (const module of allModules) {
      console.log(`\n🔹 ${module.name}`);
      console.log(`   ID: ${module._id}`);
      console.log(`   Functions (${module.functions.length}): ${module.functions.join(', ')}`);
      console.log(`   Created: ${module.createdAt}`);
    }
    console.log('\n' + '═'.repeat(80) + '\n');

    // Generate all possible privileges for verification
    console.log('🎯 Generated Privileges:');
    console.log('─'.repeat(80));
    const generatedPrivileges = [];
    for (const module of allModules) {
      for (const func of module.functions) {
        const privilege = `${func}_${module.name}`;
        generatedPrivileges.push(privilege);
      }
    }
    generatedPrivileges.sort();
    console.log(generatedPrivileges.join('\n'));
    console.log('─'.repeat(80) + '\n');

    console.log(`Total privileges that can be generated: ${generatedPrivileges.length}`);
    console.log(`Original privileges count: ${privileges.length}`);

    if (generatedPrivileges.length === privileges.length) {
      console.log('All privileges match! Setup successful!\n');
    } else {
      console.log('⚠️  Warning: Privilege count mismatch. Please verify.\n');
    }

    console.log('🎉 Module setup completed successfully!\n');

  } catch (error) {
    console.error(' Error during module setup:', error);
    throw error;
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log('👋 Database connection closed');
  }
}

// Run the setup
if (require.main === module) {
  setupModules()
    .then(() => {
      console.log('\nScript completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n Script failed:', error);
      process.exit(1);
    });
}

module.exports = { setupModules, parsePrivileges };
