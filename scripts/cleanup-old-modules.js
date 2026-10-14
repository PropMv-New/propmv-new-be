/**
 * ------------------------------------------------------------------
 * File: cleanup-old-modules.js
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
require('dotenv').config();

/**
 * Cleanup Script: Clean up old/incorrect modules and functions
 */

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://support_db_user:bCmGvGJJBywa9itS@cluster0.9qkrxlz.mongodb.net/';

async function cleanupOldData() {
  try {
    console.log('═'.repeat(70));
    console.log('  Cleanup: Remove Old/Incorrect Modules and Functions');
    console.log('═'.repeat(70));
    console.log('\n');

    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB\n');

    const moduleSchema = new mongoose.Schema(
      {
        name: { type: String, required: true, unique: true, trim: true },
        displayName: { type: String, required: true },
        icon: { type: String },
        functions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Function' }],
        description: { type: String },
      },
      { timestamps: true }
    );

    const ModuleModel = mongoose.models.Module || mongoose.model('Module', moduleSchema);
    const FunctionModel = require('../src/shared/modules/auth/models/function.model');

    // Expected modules
    const VALID_MODULES = ['Property', 'Tenants', 'Application', 'Lease', 'Income', 'Expense', 'Maintenance', 'Listings', 'Message', 'Email'];

    // Valid functions
    const VALID_FUNCTIONS = ['View', 'Create', 'Edit', 'Delete', 'Send', 'Compose'];

    // Find and delete modules that are not in the valid list or have no name/displayName
    console.log('🔍 Checking for invalid modules...\n');
    const allModules = await ModuleModel.find({});

    for (const module of allModules) {
      if (!module.displayName || !VALID_MODULES.includes(module.name)) {
        console.log(`🗑️  Deleting invalid module: "${module.name}" (ID: ${module._id})`);
        await ModuleModel.deleteOne({ _id: module._id });
      }
    }

    // Find and delete functions that are not in the valid list
    console.log('\n🔍 Checking for invalid functions...\n');
    const allFunctions = await FunctionModel.find({});

    for (const func of allFunctions) {
      if (!VALID_FUNCTIONS.includes(func.name)) {
        console.log(`🗑️  Deleting invalid function: "${func.name}" (ID: ${func._id})`);
        await FunctionModel.deleteOne({ _id: func._id });
      }
    }

    console.log('\nCleanup completed!\n');

    // Verify final state
    console.log('📊 Final state after cleanup:\n');
    const finalModules = await ModuleModel.find({}).sort({ name: 1 });
    const finalFunctions = await FunctionModel.find({}).sort({ name: 1 });

    console.log(`Modules: ${finalModules.length}`);
    finalModules.forEach(m => console.log(`  • ${m.name}`));

    console.log(`\nFunctions: ${finalFunctions.length}`);
    finalFunctions.forEach(f => console.log(`  • ${f.name}`));

  } catch (error) {
    console.error('\n ERROR:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB\n');
  }
}

// Run the cleanup
cleanupOldData();
