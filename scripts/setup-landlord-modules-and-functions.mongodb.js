/**
 * ------------------------------------------------------------------
 * File: setup-landlord-modules-and-functions.mongodb.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// MongoDB Shell Script for Landlord Modules and Functions Setup
// This script can be run directly in MongoDB Compass or mongosh
// Usage in mongosh: mongosh "mongodb+srv://user:pass@cluster.mongodb.net/dbname" < setup-landlord-modules-and-functions.mongodb.js

// Switch to the correct database
use propmv;

// Step 1: Insert Functions (Permissions)
console.log("📝 Inserting functions...");

const functions = [
  // Dashboard Functions
  { name: 'dashboard.view', description: 'View dashboard' },
  { name: 'dashboard.edit', description: 'Edit dashboard' },

  // Properties Functions
  { name: 'properties.view', description: 'View properties' },
  { name: 'properties.create', description: 'Create new property' },
  { name: 'properties.edit', description: 'Edit properties' },
  { name: 'properties.delete', description: 'Delete properties' },

  // Tenants Functions
  { name: 'tenants.view', description: 'View tenants' },
  { name: 'tenants.create', description: 'Create tenant' },
  { name: 'tenants.edit', description: 'Edit tenant' },
  { name: 'tenants.delete', description: 'Delete tenant' },

  // Leases Functions
  { name: 'leases.view', description: 'View leases' },
  { name: 'leases.create', description: 'Create lease' },
  { name: 'leases.edit', description: 'Edit lease' },
  { name: 'leases.delete', description: 'Delete lease' },

  // Income Functions
  { name: 'income.view', description: 'View income' },
  { name: 'income.create', description: 'Create income record' },
  { name: 'income.edit', description: 'Edit income' },
  { name: 'income.delete', description: 'Delete income' },

  // Maintenance Functions
  { name: 'maintenance.view', description: 'View maintenance requests' },
  { name: 'maintenance.create', description: 'Create maintenance request' },
  { name: 'maintenance.edit', description: 'Edit maintenance request' },
  { name: 'maintenance.delete', description: 'Delete maintenance request' },

  // Messaging Functions
  { name: 'messaging.view', description: 'View messages' },
  { name: 'messaging.create', description: 'Send messages' },
  { name: 'messaging.manage', description: 'Manage messaging' },

  // Reports Functions
  { name: 'reports.view', description: 'View reports' },
  { name: 'reports.export', description: 'Export reports' },

  // Settings Functions
  { name: 'settings.view', description: 'View settings' },
  { name: 'settings.edit', description: 'Edit settings' },

  // Users Functions
  { name: 'users.view', description: 'View users' },
  { name: 'users.create', description: 'Create user' },
  { name: 'users.edit', description: 'Edit user' },
  { name: 'users.delete', description: 'Delete user' },
];

// Insert functions and get their IDs
const functionIds = {};
functions.forEach(func => {
  const existing = db.functions.findOne({ name: func.name });
  if (existing) {
    console.log(`   ℹ️  Function "${func.name}" already exists`);
    functionIds[func.name] = existing._id;
  } else {
    const result = db.functions.insertOne({
      ...func,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    console.log(`   Created function: "${func.name}"`);
    functionIds[func.name] = result.insertedId;
  }
});

console.log(`✓ Functions processed: ${Object.keys(functionIds).length} total\n`);

// Step 2: Create Modules and Assign Functions
console.log("📦 Creating modules...");

const modules = [
  { name: 'dashboard', displayName: 'Dashboard', icon: 'LayoutDashboard' },
  { name: 'properties', displayName: 'Properties', icon: 'Building2' },
  { name: 'tenants', displayName: 'Tenants', icon: 'Users' },
  { name: 'leases', displayName: 'Leases', icon: 'FileText' },
  { name: 'income', displayName: 'Income', icon: 'DollarSign' },
  { name: 'maintenance', displayName: 'Maintenance', icon: 'Wrench' },
  { name: 'messaging', displayName: 'Messaging', icon: 'MessageSquare' },
  { name: 'reports', displayName: 'Reports', icon: 'BarChart3' },
  { name: 'settings', displayName: 'Settings', icon: 'Settings' },
  { name: 'users', displayName: 'Users', icon: 'Users' },
];

const moduleIds = {};
modules.forEach(module => {
  // Get functions related to this module
  const moduleFunctionNames = functions
    .filter(f => f.name.startsWith(module.name + '.'))
    .map(f => f.name);

  const moduleFunctionIds = moduleFunctionNames
    .map(name => functionIds[name])
    .filter(id => id !== undefined);

  const existing = db.modules.findOne({ name: module.name });
  if (existing) {
    console.log(`   ℹ️  Module "${module.name}" already exists`);
    moduleIds[module.name] = existing._id;
  } else {
    const result = db.modules.insertOne({
      ...module,
      functions: moduleFunctionIds,
      description: `${module.displayName} module for landlords`,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    console.log(`   Created module: "${module.name}" with ${moduleFunctionIds.length} functions`);
    moduleIds[module.name] = result.insertedId;
  }
});

console.log(`✓ Modules processed: ${Object.keys(moduleIds).length} total\n`);

// Step 3: Assign all functions to Landlord role
console.log("🔗 Updating Landlord role...");

const allFunctionIds = Object.values(functionIds);
const sidebarModules = Object.keys(moduleIds);

const landlordRole = db.roles.findOne({ name: 'Landlord' });

if (!landlordRole) {
  console.log(" Landlord role not found! Creating it...");
  const result = db.roles.insertOne({
    name: 'Landlord',
    description: 'Landlord user role',
    functions: allFunctionIds,
    sidebar: sidebarModules,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  console.log(`Created Landlord role with ID: ${result.insertedId}`);
} else {
  console.log(`Updating existing Landlord role (ID: ${landlordRole._id})`);
  db.roles.updateOne(
    { _id: landlordRole._id },
    {
      $set: {
        functions: allFunctionIds,
        sidebar: sidebarModules,
        updatedAt: new Date()
      }
    }
  );
  console.log(`   • Functions assigned: ${allFunctionIds.length}`);
  console.log(`   • Sidebar modules: ${sidebarModules.length}\n`);
}

// Step 4: Verification
console.log("─".repeat(70));
console.log("📊 VERIFICATION REPORT\n");

const finalRole = db.roles.findOne({ name: 'Landlord' });
if (finalRole) {
  console.log(`Landlord Role ID: ${finalRole._id}`);
  console.log(`   Description: ${finalRole.description}`);
  console.log(`   Total Functions: ${finalRole.functions?.length || 0}`);
  console.log(`   Sidebar Modules: ${finalRole.sidebar?.length || 0}\n`);
}

const totalFunctions = db.functions.countDocuments({});
const totalModules = db.modules.countDocuments({});

console.log("Summary:");
console.log(`  • Total functions in DB: ${totalFunctions}`);
console.log(`  • Total modules in DB: ${totalModules}`);
console.log(`  • Functions assigned to Landlord: ${finalRole?.functions?.length || 0}`);
console.log(`  • Modules in Landlord sidebar: ${finalRole?.sidebar?.length || 0}\n`);

console.log("─".repeat(70));
console.log("Setup completed successfully!\n");
