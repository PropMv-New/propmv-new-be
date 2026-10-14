/**
 * ------------------------------------------------------------------
 * File: test-s3-presigned-url.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Test script to verify AWS SDK v3 presigned URL generation
// Run: node scripts/test-s3-presigned-url.js

require('dotenv').config();
const s3Client = require('../src/integrations/s3');

async function testPresignedUrl() {
  console.log('\n🧪 Testing S3 Presigned URL Generation...\n');

  // Test with a sample key (use an actual key from your S3 bucket)
  const testKey = 'Property/697db8cacdd6418e078aa166/1778006817407-61c6f847fd53-69f43f92e1b64dfa1e788c92_1778006817174.jpg';

  try {
    console.log('📝 Test Key:', testKey);
    console.log('🪣 Bucket:', process.env.S3_BUCKET);
    console.log('🌍 Region:', process.env.AWS_REGION);
    console.log('');

    const url = await s3Client.getPresignedUrl({ key: testKey, expiresIn: 3600 });

    console.log('Presigned URL generated successfully!\n');
    console.log('🔗 URL:', url);
    console.log('');
    console.log('📊 URL Analysis:');
    console.log('  - Contains X-Amz-Algorithm:', url.includes('X-Amz-Algorithm') ? '' : '');
    console.log('  - Contains X-Amz-Credential:', url.includes('X-Amz-Credential') ? '' : '');
    console.log('  - Contains X-Amz-Signature:', url.includes('X-Amz-Signature') ? '' : '');
    console.log('  - Contains X-Amz-Expires:', url.includes('X-Amz-Expires') ? '' : '');
    console.log('  - Uses HTTPS:', url.startsWith('https://') ? '' : '');
    console.log('');

    // Check if URL has proper ampersands (not HTML encoded)
    const ampersandCount = (url.match(/&/g) || []).length;
    const htmlEncodedCount = (url.match(/&amp;/g) || []).length;

    console.log('🔍 URL Encoding Check:');
    console.log('  - Regular ampersands (&):', ampersandCount);
    console.log('  - HTML encoded (&amp;):', htmlEncodedCount);
    console.log('  - Status:', htmlEncodedCount === 0 ? 'Correct' : ' Has HTML encoding');
    console.log('');

    console.log('💡 Next Steps:');
    console.log('  1. Copy the URL above');
    console.log('  2. Paste it in a new browser tab');
    console.log('  3. The image should download/display');
    console.log('  4. If it works, the fix is successful!');
    console.log('');

  } catch (error) {
    console.error(' Error generating presigned URL:', error.message);
    console.error('');
    console.error('🔧 Troubleshooting:');
    console.error('  1. Check AWS credentials in .env file');
    console.error('  2. Verify S3_BUCKET is correct');
    console.error('  3. Ensure AWS_REGION is correct');
    console.error('  4. Run: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner');
    console.error('');
    process.exit(1);
  }
}

testPresignedUrl();
