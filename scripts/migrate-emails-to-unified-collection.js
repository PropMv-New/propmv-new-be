/**
 * ------------------------------------------------------------------
 * File: migrate-emails-to-unified-collection.js
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

// Old models
const SentEmail = mongoose.model('SentEmail', new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  to: String,
  cc: String,
  bcc: String,
  subject: String,
  body: String,
  sentAt: Date,
}, { timestamps: true }));

const DraftEmail = mongoose.model('DraftEmail', new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  to: String,
  cc: String,
  bcc: String,
  subject: String,
  body: String,
}, { timestamps: true }));

// New unified model
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

async function migrateEmails() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/propmv';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Migrate SentEmails
    const sentEmails = await SentEmail.find({});
    console.log(`📧 Found ${sentEmails.length} sent emails to migrate`);

    for (const sentEmail of sentEmails) {
      const existingEmail = await Email.findOne({
        userId: sentEmail.userId,
        to: sentEmail.to,
        subject: sentEmail.subject,
        sentAt: sentEmail.sentAt,
        status: 'sent'
      });

      if (!existingEmail) {
        await Email.create({
          userId: sentEmail.userId,
          to: sentEmail.to,
          cc: sentEmail.cc,
          bcc: sentEmail.bcc,
          subject: sentEmail.subject,
          body: sentEmail.body,
          status: 'sent',
          sentAt: sentEmail.sentAt,
          createdAt: sentEmail.createdAt,
          updatedAt: sentEmail.updatedAt,
        });
        console.log(`Migrated sent email: ${sentEmail._id}`);
      } else {
        console.log(`⏭️  Skipped duplicate sent email: ${sentEmail._id}`);
      }
    }

    // Migrate DraftEmails
    const draftEmails = await DraftEmail.find({});
    console.log(`📋 Found ${draftEmails.length} draft emails to migrate`);

    for (const draftEmail of draftEmails) {
      const existingEmail = await Email.findOne({
        userId: draftEmail.userId,
        to: draftEmail.to,
        subject: draftEmail.subject,
        status: 'draft',
        createdAt: draftEmail.createdAt
      });

      if (!existingEmail) {
        await Email.create({
          userId: draftEmail.userId,
          to: draftEmail.to,
          cc: draftEmail.cc,
          bcc: draftEmail.bcc,
          subject: draftEmail.subject,
          body: draftEmail.body,
          status: 'draft',
          createdAt: draftEmail.createdAt,
          updatedAt: draftEmail.updatedAt,
        });
        console.log(`Migrated draft email: ${draftEmail._id}`);
      } else {
        console.log(`⏭️  Skipped duplicate draft email: ${draftEmail._id}`);
      }
    }

    console.log('\nMigration completed successfully!');
    console.log(`📊 Total emails in unified collection: ${await Email.countDocuments()}`);
    console.log(`   - Sent: ${await Email.countDocuments({ status: 'sent' })}`);
    console.log(`   - Draft: ${await Email.countDocuments({ status: 'draft' })}`);
    console.log(`   - Failed: ${await Email.countDocuments({ status: 'failed' })}`);

    console.log('\n⚠️  Note: Old collections (sentemails, draftemails) are still present.');
    console.log('   You can drop them manually after verifying the migration:');
    console.log('   db.sentemails.drop()');
    console.log('   db.draftemails.drop()');

  } catch (error) {
    console.error(' Migration failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
  }
}

// Run migration
migrateEmails();
