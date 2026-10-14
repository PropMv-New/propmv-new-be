/**
 * ------------------------------------------------------------------
 * File: migrate-documents-to-s3.js
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
 * Migration Script: Move existing documents from local storage to AWS S3
 * 
 * This script migrates documents from mock_s3 or uploads folder to AWS S3 bucket
 * with the new user-specific folder structure.
 * 
 * Usage:
 *   node scripts/migrate-documents-to-s3.js
 * 
 * Prerequisites:
 *   1. AWS credentials configured in .env
 *   2. S3 bucket created (propmv-docs)
 *   3. Backup of existing files
 */

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

// Configuration
const config = {
  mongoUrl: process.env.DB_URL,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  s3Bucket: process.env.S3_BUCKET || 'propmv-docs',
  sourceDir: process.env.S3_MOCK_DIR || './mock_s3', // Source directory
  dryRun: process.env.DRY_RUN === 'true', // Set to true for testing
};

// Initialize AWS S3
const s3 = new S3Client({
  region: config.awsRegion,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Document Metadata Model
const DocumentMetadataSchema = new mongoose.Schema({
  isDeleted: { type: Boolean, default: false },
  key: { type: String, required: true },
  s3Location: { type: String },
  originalName: { type: String },
  bucketName: { type: String, required: true },
  region: { type: String, required: true },
  size: { type: Number, required: true },
  contentType: { type: String, required: true },
}, { timestamps: true });

const DocumentMetadata = mongoose.model('DocumentMetadata', DocumentMetadataSchema);

// Module folder mapping (old -> new)
const folderMapping = {
  'properties': 'Property',
  'property-images': 'Property',
  'tenants': 'Tenants',
  'tenant-documents': 'Tenants',
  'applications': 'Applications',
  'lease-documents': 'Lease & files',
  'invoice-documents': 'Income',
  'expense-receipts': 'Expense',
  'maintenance-attachments': 'Maintenance',
  'message-attachments': 'Messaging',
  'email-attachments': 'Email',
  'listing-images': 'Listings',
};

// Statistics
const stats = {
  total: 0,
  migrated: 0,
  skipped: 0,
  failed: 0,
  errors: [],
};

/**
 * Extract user ID from file path or metadata
 * This is a placeholder - adjust based on your actual data structure
 */
function extractUserId(metadata, filePath) {
  // Try to extract from metadata if available
  // This needs to be customized based on your data structure
  
  // Option 1: If you have a reference to user in metadata
  // return metadata.userId;
  
  // Option 2: If you track uploads by user in a separate collection
  // Look up the user who uploaded this document
  
  // Option 3: Default fallback - use a default user ID
  return 'default-user'; // Replace with actual logic
}

/**
 * Determine new S3 key based on old key and user ID
 */
function getNewS3Key(oldKey, userId) {
  const parts = oldKey.split('/');
  const filename = parts[parts.length - 1];
  const oldFolder = parts[0];
  
  // Map old folder to new folder
  const newFolder = folderMapping[oldFolder] || oldFolder;
  
  // Build new key: <MODULE>/<USER_ID>/<filename>
  return `${newFolder}/${userId}/${filename}`;
}

/**
 * Upload file to S3
 */
async function uploadToS3(localPath, s3Key, contentType) {
  if (config.dryRun) {
    console.log(`[DRY RUN] Would upload: ${localPath} -> s3://${config.s3Bucket}/${s3Key}`);
    return {
      Location: `https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com/${s3Key}`,
      Key: s3Key,
    };
  }

  const fileContent = await fs.promises.readFile(localPath);
  
  await s3.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: s3Key,
    Body: fileContent,
    ContentType: contentType,
  }));
  return {
    Location: `https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com/${s3Key}`,
    Key: s3Key,
  };
}

/**
 * Migrate a single document
 */
async function migrateDocument(metadata) {
  try {
    stats.total++;
    
    // Skip if already migrated (check if s3Location points to S3)
    if (metadata.s3Location && metadata.s3Location.includes('amazonaws.com')) {
      console.log(`Skipping already migrated: ${metadata._id}`);
      stats.skipped++;
      return;
    }

    // Build local file path and guard against path traversal
    const resolvedSourceDir = path.resolve(config.sourceDir);
    const localPath = path.resolve(resolvedSourceDir, metadata.key);
    if (!localPath.startsWith(resolvedSourceDir + path.sep)) {
      console.warn(`Skipping unsafe path for ${metadata._id}: ${metadata.key}`);
      stats.skipped++;
      return;
    }
    
    // Check if file exists
    if (!fs.existsSync(localPath)) {
      console.warn(`File not found: ${localPath}`);
      stats.skipped++;
      return;
    }

    // Extract user ID (customize this based on your data)
    const userId = extractUserId(metadata, localPath);
    
    // Generate new S3 key
    const newKey = getNewS3Key(metadata.key, userId);
    
    // Upload to S3
    console.log(`Migrating: ${metadata.key} -> ${newKey}`);
    const result = await uploadToS3(localPath, newKey, metadata.contentType);
    
    // Update metadata in database
    if (!config.dryRun) {
      await DocumentMetadata.findByIdAndUpdate(metadata._id, {
        key: result.Key,
        s3Location: result.Location,
        bucketName: config.s3Bucket,
        region: config.awsRegion,
      });
    }
    
    console.log(`✓ Migrated: ${metadata._id}`);
    stats.migrated++;
    
  } catch (error) {
    console.error(`✗ Failed to migrate ${metadata._id}:`, error.message);
    stats.failed++;
    stats.errors.push({
      metadataId: metadata._id,
      error: error.message,
    });
  }
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('='.repeat(60));
  console.log('Document Migration to AWS S3');
  console.log('='.repeat(60));
  console.log(`Source Directory: ${config.sourceDir}`);
  console.log(`S3 Bucket: ${config.s3Bucket}`);
  console.log(`AWS Region: ${config.awsRegion}`);
  console.log(`Dry Run: ${config.dryRun ? 'YES' : 'NO'}`);
  console.log('='.repeat(60));
  console.log('');

  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoUrl);
    console.log('✓ Connected to MongoDB\n');

    // Get all document metadata
    console.log('Fetching document metadata...');
    const documents = await DocumentMetadata.find({ isDeleted: false });
    console.log(`✓ Found ${documents.length} documents\n`);

    // Migrate each document
    console.log('Starting migration...\n');
    for (const doc of documents) {
      await migrateDocument(doc);
    }

    // Print statistics
    console.log('\n' + '='.repeat(60));
    console.log('Migration Complete');
    console.log('='.repeat(60));
    console.log(`Total Documents: ${stats.total}`);
    console.log(`Migrated: ${stats.migrated}`);
    console.log(`Skipped: ${stats.skipped}`);
    console.log(`Failed: ${stats.failed}`);
    
    if (stats.errors.length > 0) {
      console.log('\nErrors:');
      stats.errors.forEach(err => {
        console.log(`  - ${err.metadataId}: ${err.error}`);
      });
    }
    
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
  }
}

// Run migration
if (require.main === module) {
  migrate()
    .then(() => {
      console.log('\n✓ Migration script completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n✗ Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrate };
