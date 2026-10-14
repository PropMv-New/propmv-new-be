/**
 * ------------------------------------------------------------------
 * File: test-aws-s3-connection.js
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
 * Test AWS S3 Connection
 *
 * Usage: node scripts/test-aws-s3-connection.js
 */

// Use the same env loader as the API server (loads propmv/.env)
require('../src/config/loadEnv');
const {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

console.log('='.repeat(60));
console.log('AWS S3 Connection Test');
console.log('='.repeat(60));
console.log('');

const accessKeySet = !!(process.env.AWS_ACCESS_KEY_ID || '').trim();
const secretKeySet = !!(process.env.AWS_SECRET_ACCESS_KEY || '').trim();

console.log('Configuration:');
console.log(`  APP_PROFILE: ${process.env.APP_PROFILE}`);
console.log(`  STORAGE_PROVIDER: ${process.env.STORAGE_PROVIDER || '(unset)'}`);
console.log(`  MOCKS3: ${process.env.MOCKS3}`);
console.log(`  AWS_REGION: ${process.env.AWS_REGION}`);
console.log(`  S3_BUCKET: ${process.env.S3_BUCKET}`);
console.log(`  AWS_ACCESS_KEY_ID: ${accessKeySet ? '✓ Set' : '✗ Not set (empty in .env)'}`);
console.log(`  AWS_SECRET_ACCESS_KEY: ${secretKeySet ? '✓ Set' : '✗ Not set (empty in .env)'}`);
console.log('');

if (!accessKeySet || !secretKeySet) {
  console.error('✗ ERROR: AWS credentials are empty in propmv/.env');
  console.error('  Open propmv/.env and set BOTH values on these lines:');
  console.error('    AWS_ACCESS_KEY_ID=AKIA...');
  console.error('    AWS_SECRET_ACCESS_KEY=...');
  console.error('  Then save the file and re-run this script.');
  process.exit(1);
}

if (process.env.MOCKS3 === 'true') {
  console.warn('⚠ WARNING: MOCKS3=true');
  console.warn('  Files will go to mock_s3/ folder, not AWS S3');
  console.warn('  Set MOCKS3=false to use AWS S3');
  console.log('');
}

async function testConnection() {
  try {
    console.log('Testing AWS S3 connection...');
    console.log('');

    const s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const bucketName = process.env.S3_BUCKET || 'propmv-docs';

    // Test 1: List buckets
    console.log('Test 1: Listing S3 buckets...');
    const bucketsResult = await s3.send(new ListBucketsCommand({}));
    console.log('✓ Successfully connected to AWS S3');
    console.log(`  Found ${bucketsResult.Buckets.length} bucket(s)`);

    const bucketExists = bucketsResult.Buckets.some(b => b.Name === bucketName);
    if (bucketExists) {
      console.log(`✓ Bucket "${bucketName}" exists`);
    } else {
      console.warn(`⚠ Bucket "${bucketName}" not found`);
      console.warn(`  Available buckets: ${bucketsResult.Buckets.map(b => b.Name).join(', ')}`);
      console.warn('  Please create the bucket or update S3_BUCKET in .env');
    }
    console.log('');

    if (bucketExists) {
      // Test 2: Check bucket access
      console.log('Test 2: Checking bucket access...');
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
        console.log(`✓ Can access bucket "${bucketName}"`);
      } catch (err) {
        console.error(`✗ Cannot access bucket "${bucketName}"`);
        console.error(`  Error: ${err.message}`);
      }
      console.log('');

      // Test 3: List objects
      console.log('Test 3: Listing objects in bucket...');
      try {
        const objectsResult = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 10 }));
        console.log('✓ Successfully listed objects');
        console.log(`  Found ${objectsResult.KeyCount} object(s)`);
        if (objectsResult.KeyCount > 0) {
          console.log('  Recent objects:');
          objectsResult.Contents.slice(0, 5).forEach(obj => {
            console.log(`    - ${obj.Key} (${obj.Size} bytes)`);
          });
        }
      } catch (err) {
        console.error('✗ Cannot list objects');
        console.error(`  Error: ${err.message}`);
      }
      console.log('');

      // Test 4: Upload test file
      console.log('Test 4: Testing file upload...');
      try {
        const testKey = `test/${Date.now()}-test.txt`;
        await s3.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: testKey,
          Body: 'This is a test file from PropMv backend',
          ContentType: 'text/plain',
        }));
        console.log('✓ Successfully uploaded test file');
        console.log(`  Key: ${testKey}`);
        console.log(`  URL: https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${testKey}`);

        console.log('  Cleaning up test file...');
        await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: testKey }));
        console.log('  ✓ Test file deleted');
      } catch (err) {
        console.error('✗ Cannot upload test file');
        console.error(`  Error: ${err.message}`);
      }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('✓ AWS S3 Connection Test Complete');
    console.log('='.repeat(60));
    console.log('');
    console.log('Your AWS S3 is configured correctly!');
    console.log('You can now upload documents to AWS S3.');
    console.log('');
  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('✗ AWS S3 Connection Test Failed');
    console.error('='.repeat(60));
    console.error('');
    console.error('Error:', error.message);
    console.error('');

    if (error.name === 'InvalidAccessKeyId') {
      console.error('Possible causes:');
      console.error('  - AWS_ACCESS_KEY_ID is incorrect');
      console.error('  - Access key has been deleted or deactivated');
    } else if (error.name === 'SignatureDoesNotMatch') {
      console.error('Possible causes:');
      console.error('  - AWS_SECRET_ACCESS_KEY is incorrect');
      console.error('  - Credentials do not match');
    } else if (error.name === 'AccessDenied') {
      console.error('Possible causes:');
      console.error('  - IAM user does not have S3 permissions');
      console.error('  - Bucket policy restricts access');
    }

    console.error('');
    console.error('Please check your AWS credentials and try again.');
    console.error('');
    process.exit(1);
  }
}

testConnection();
