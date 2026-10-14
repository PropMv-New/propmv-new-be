/**
 * ------------------------------------------------------------------
 * File: migrate-expense-status.js
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
 * Migration Script: Update Expense Status Values
 * 
 * This script migrates existing expense records to use the new status values:
 * - 'unpaid' → 'pending' or 'overdue' (based on due date)
 * - 'partial' → 'partially_paid'
 * 
 * Run this script ONCE after deploying the new expense status constants.
 * 
 * Usage: node scripts/migrate-expense-status.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import both expense models to handle shared collection
const LandlordExpense = require('../src/shared/modules/expense/model/expense.model');
const HoaExpense = require('../src/portals/hoa-board/modules/expense/model/expense.model');

async function migrateExpenseStatus() {
  try {
    console.log('🚀 Starting expense status migration...');

    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI or MONGO_URI environment variable is not set');
    }

    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const now = new Date();
    let updatedCount = 0;
    let errorCount = 0;

    // Get all expenses with old status values
    const expensesCollection = mongoose.connection.collection('expenses');

    // Find expenses with 'unpaid' status
    console.log('\n📊 Processing expenses with "unpaid" status...');
    const unpaidExpenses = await expensesCollection.find({ status: 'unpaid' }).toArray();
    console.log(`Found ${unpaidExpenses.length} expenses with "unpaid" status`);

    for (const expense of unpaidExpenses) {
      try {
        const dueDate = new Date(expense.dueDate);
        const newStatus = dueDate < now ? 'overdue' : 'pending';

        await expensesCollection.updateOne(
          { _id: expense._id },
          { $set: { status: newStatus } }
        );

        updatedCount++;
        console.log(`  ✓ Updated expense ${expense._id}: unpaid → ${newStatus}`);
      } catch (error) {
        errorCount++;
        console.error(`  ✗ Error updating expense ${expense._id}:`, error.message);
      }
    }

    // Find expenses with 'partial' status
    console.log('\n📊 Processing expenses with "partial" status...');
    const partialExpenses = await expensesCollection.find({ status: 'partial' }).toArray();
    console.log(`Found ${partialExpenses.length} expenses with "partial" status`);

    for (const expense of partialExpenses) {
      try {
        await expensesCollection.updateOne(
          { _id: expense._id },
          { $set: { status: 'partially_paid' } }
        );

        updatedCount++;
        console.log(`  ✓ Updated expense ${expense._id}: partial → partially_paid`);
      } catch (error) {
        errorCount++;
        console.error(`  ✗ Error updating expense ${expense._id}:`, error.message);
      }
    }

    // Verify migration
    console.log('\n🔍 Verifying migration...');
    const remainingOldStatus = await expensesCollection.countDocuments({
      status: { $in: ['unpaid', 'partial'] }
    });

    if (remainingOldStatus > 0) {
      console.warn(`⚠️  Warning: ${remainingOldStatus} expenses still have old status values`);
    } else {
      console.log('All expenses have been migrated to new status values');
    }

    // Summary
    console.log('\n📈 Migration Summary:');
    console.log(`  Total updated: ${updatedCount}`);
    console.log(`  Errors: ${errorCount}`);
    console.log(`  Remaining old status: ${remainingOldStatus}`);

    // Show current status distribution
    console.log('\n📊 Current Status Distribution:');
    const statusCounts = await expensesCollection.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    statusCounts.forEach(({ _id, count }) => {
      console.log(`  ${_id}: ${count}`);
    });

    console.log('\nMigration completed successfully!');

  } catch (error) {
    console.error('\n Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run migration
if (require.main === module) {
  migrateExpenseStatus()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = migrateExpenseStatus;
