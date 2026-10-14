/**
 * ------------------------------------------------------------------
 * File: test-lockcheck.js
 * Module: Backend Core
 *
 * Purpose:
 * Backend utility/module providing helper functions for test-lockcheck.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

require('dotenv').config({ path: '.env.local' });
const mongoose = require('mongoose');
const User = require('./src/shared/modules/users/models/user.model');

async function testLockCheck() {
  try {
    await mongoose.connect(process.env.DB_URL);
    console.log('Connected to MongoDB\n');

    // Test finding a user
    const testUser = await User.findOne({ isDeleted: { $ne: true } })
      .select('lockAccount lockUntil failedLoginAttempts isDeleted email')
      .lean();

    if (testUser) {
      console.log('Successfully fetched user:');
      console.log('   Email:', testUser.email);
      console.log('   Lock Account:', testUser.lockAccount);
      console.log('   Is Deleted:', testUser.isDeleted);
    } else {
      console.log(' No users found');
    }

    await mongoose.disconnect();
    console.log('\nTest complete');
    process.exit(0);
  } catch (error) {
    console.error(' Error:', error.message);
    console.error(error.stack);
    await mongoose.disconnect();
    process.exit(1);
  }
}

testLockCheck();
