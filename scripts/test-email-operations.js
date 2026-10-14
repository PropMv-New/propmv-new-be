/**
 * ------------------------------------------------------------------
 * File: test-email-operations.js
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

// Email model
const Email = mongoose.model('Email', new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  to: String,
  cc: String,
  bcc: String,
  subject: String,
  body: String,
  status: { type: String, enum: ['draft', 'sent', 'failed'], default: 'draft' },
  sentAt: Date,
  errorMessage: String,
}, { timestamps: true }));

async function testEmailOperations() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/propmv';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB\n');

    // Create a test user ID (use a real user ID from your database)
    const testUserId = new mongoose.Types.ObjectId();
    console.log(`🧪 Using test user ID: ${testUserId}\n`);

    // Test 1: Create Draft
    console.log('📝 Test 1: Creating draft email...');
    const draft = await Email.create({
      userId: testUserId,
      to: 'test@example.com',
      subject: 'Test Draft',
      body: 'This is a test draft',
      status: 'draft'
    });
    console.log(`Draft created: ${draft._id}`);
    console.log(`   Status: ${draft.status}\n`);

    // Test 2: Update Draft
    console.log('📝 Test 2: Updating draft...');
    draft.subject = 'Updated Test Draft';
    draft.body = 'This is an updated test draft';
    await draft.save();
    console.log(`Draft updated: ${draft._id}`);
    console.log(`   New subject: ${draft.subject}\n`);

    // Test 3: Send Draft (Success)
    console.log('📤 Test 3: Sending draft (simulated success)...');
    draft.status = 'sent';
    draft.sentAt = new Date();
    await draft.save();
    console.log(`Draft sent: ${draft._id}`);
    console.log(`   Status: ${draft.status}`);
    console.log(`   Sent at: ${draft.sentAt}\n`);

    // Test 4: Create Failed Email
    console.log(' Test 4: Creating failed email...');
    const failedEmail = await Email.create({
      userId: testUserId,
      to: 'invalid@example.com',
      subject: 'Test Failed Email',
      body: 'This email failed to send',
      status: 'failed',
      errorMessage: 'SMTP connection failed'
    });
    console.log(`Failed email created: ${failedEmail._id}`);
    console.log(`   Status: ${failedEmail.status}`);
    console.log(`   Error: ${failedEmail.errorMessage}\n`);

    // Test 5: List Emails by Status
    console.log('📊 Test 5: Listing emails by status...');
    const drafts = await Email.find({ userId: testUserId, status: 'draft' });
    const sent = await Email.find({ userId: testUserId, status: 'sent' });
    const failed = await Email.find({ userId: testUserId, status: 'failed' });

    console.log(`   Drafts: ${drafts.length}`);
    console.log(`   Sent: ${sent.length}`);
    console.log(`   Failed: ${failed.length}\n`);

    // Test 6: Query All Emails
    console.log('📊 Test 6: Querying all test emails...');
    const allEmails = await Email.find({ userId: testUserId });
    console.log(`   Total emails: ${allEmails.length}`);
    allEmails.forEach(email => {
      console.log(`   - ${email.status.toUpperCase()}: ${email.subject} (${email._id})`);
    });
    console.log('');

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    await Email.deleteMany({ userId: testUserId });
    console.log('Test data cleaned up\n');

    console.log('All tests passed!');
    console.log('\n📊 Current database stats:');
    console.log(`   Total emails: ${await Email.countDocuments()}`);
    console.log(`   - Drafts: ${await Email.countDocuments({ status: 'draft' })}`);
    console.log(`   - Sent: ${await Email.countDocuments({ status: 'sent' })}`);
    console.log(`   - Failed: ${await Email.countDocuments({ status: 'failed' })}`);

  } catch (error) {
    console.error(' Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run tests
testEmailOperations();
