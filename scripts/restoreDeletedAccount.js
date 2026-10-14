/**
 * ------------------------------------------------------------------
 * File: restoreDeletedAccount.js
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
 * Recovery Script: Restore Deleted Board Member Account
 * 
 * Usage: node scripts/restoreDeletedAccount.js <email>
 * Example: node scripts/restoreDeletedAccount.js boardmember@example.com
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/propmv';

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

async function restoreAccount(email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    console.error(' Invalid email address provided.');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const User = require('../src/shared/modules/users/models/user.model');

    const normalizedEmail = String(email).toLowerCase().trim();
    if (!EMAIL_RE.test(normalizedEmail)) {
      console.error(' Invalid email address after normalization.');
      process.exit(1);
    }
    const user = await User.findOne({ email: { $eq: normalizedEmail } });

    if (!user) {
      console.error(` User with email "${normalizedEmail}" not found`);
      process.exit(1);
    }

    if (!user.isDeleted) {
      console.log(`User "${normalizedEmail}" is not deleted. No action needed.`);
      process.exit(0);
    }

    // Restore the account
    await User.findByIdAndUpdate(user._id, {
      $set: { isDeleted: false, updatedAt: new Date() },
      $unset: { deletedAt: "" }
    });

    console.log(`Successfully restored account for "${normalizedEmail}"`);
    console.log(`   User ID: ${user._id}`);
    console.log(`   Name: ${user.firstName} ${user.lastName}`);

    process.exit(0);
  } catch (error) {
    console.error(' Error restoring account:', error.message);
    process.exit(1);
  }
}

// Get email from command line arguments
const email = process.argv[2];

if (!email) {
  console.error('Usage: node scripts/restoreDeletedAccount.js <email>');
  console.error('Example: node scripts/restoreDeletedAccount.js boardmember@example.com');
  process.exit(1);
}

restoreAccount(email);
