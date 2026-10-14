/**
 * ------------------------------------------------------------------
 * File: fix-html-encoded-s3-urls.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Script to fix HTML-encoded URLs in DocumentMetadata collection
// Run: node scripts/fix-html-encoded-s3-urls.js

require('dotenv').config();
const mongoose = require('mongoose');

async function fixHtmlEncodedUrls() {
  console.log('\n🔧 Fixing HTML-encoded S3 URLs in database...\n');

  try {
    // Connect to MongoDB
    const dbUrl = process.env.DB_URL;
    if (!dbUrl) {
      throw new Error('DB_URL not found in .env file');
    }

    await mongoose.connect(dbUrl);
    console.log('Connected to MongoDB\n');

    // Get DocumentMetadata collection
    const DocumentMetadata = mongoose.connection.collection('documentmetadatas');

    // Find all documents with HTML-encoded URLs
    const documents = await DocumentMetadata.find({
      $or: [
        { s3Location: { $regex: '&amp;' } },
        { url: { $regex: '&amp;' } }
      ]
    }).toArray();

    console.log(`📊 Found ${documents.length} documents with HTML-encoded URLs\n`);

    if (documents.length === 0) {
      console.log('No documents need fixing!\n');
      await mongoose.disconnect();
      return;
    }

    let fixedCount = 0;
    let errorCount = 0;

    for (const doc of documents) {
      try {
        const updates = {};

        // Fix s3Location if it has HTML encoding
        if (doc.s3Location && doc.s3Location.includes('&amp;')) {
          let fixed = doc.s3Location;
          // Decode multiple levels of HTML encoding
          while (fixed.includes('&amp;')) {
            fixed = fixed.replace(/&amp;/g, '&');
          }
          updates.s3Location = fixed;
          console.log(`  🔄 Fixing s3Location for ${doc._id}`);
          console.log(`     Before: ${doc.s3Location.substring(0, 100)}...`);
          console.log(`     After:  ${fixed.substring(0, 100)}...`);
        }

        // Fix url if it has HTML encoding
        if (doc.url && doc.url.includes('&amp;')) {
          let fixed = doc.url;
          // Decode multiple levels of HTML encoding
          while (fixed.includes('&amp;')) {
            fixed = fixed.replace(/&amp;/g, '&');
          }
          updates.url = fixed;
          console.log(`  🔄 Fixing url for ${doc._id}`);
        }

        // Update the document
        if (Object.keys(updates).length > 0) {
          await DocumentMetadata.updateOne(
            { _id: doc._id },
            { $set: updates }
          );
          fixedCount++;
          console.log(`  Fixed document ${doc._id}\n`);
        }
      } catch (error) {
        console.error(`   Error fixing document ${doc._id}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n📈 Summary:');
    console.log(`  Fixed: ${fixedCount} documents`);
    console.log(`   Errors: ${errorCount} documents`);
    console.log(`  📊 Total: ${documents.length} documents\n`);

    await mongoose.disconnect();
    console.log('Database connection closed\n');

  } catch (error) {
    console.error(' Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

fixHtmlEncodedUrls();
