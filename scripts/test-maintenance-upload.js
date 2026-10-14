/**
 * Test Script: Maintenance Document Upload via Storage Provider
 *
 * Tests the exact upload path used by POST /api/v1/hoa/maintenance/request/:id/documents
 * Verifies the 301 redirect issue is resolved.
 *
 * Usage: node scripts/test-maintenance-upload.js
 */

require('../src/config/loadEnv');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Helpers ────────────────────────────────────────────────────────────────

const PASS = '✓';
const FAIL = '✗';
const WARN = '⚠';

const results = [];

function log(symbol, label, detail = '') {
  const line = `${symbol} ${label}${detail ? ': ' + detail : ''}`;
  console.log(line);
  return line;
}

function record(name, passed, detail = '') {
  results.push({ name, passed, detail });
}

function section(title) {
  console.log('');
  console.log('─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

// ─── Temp file helper ────────────────────────────────────────────────────────

function createTempFile(content = 'PropMv maintenance upload test file') {
  const tmpPath = path.join(os.tmpdir(), `propmv-test-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, content);
  return tmpPath;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('='.repeat(60));
  console.log('Maintenance Document Upload - S3 Integration Test');
  console.log('='.repeat(60));

  // ── Step 1: Environment ──────────────────────────────────────────────────
  section('Step 1: Environment Configuration');

  const region = (process.env.AWS_REGION || '').trim();
  const bucket = (process.env.S3_BUCKET || '').trim();
  const accessKey = (process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const provider = (process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
  const mockMode = (process.env.MOCKS3 || '').toLowerCase() === 'true';

  console.log(`  STORAGE_PROVIDER : ${provider || '(unset - will auto-detect)'}`);
  console.log(`  AWS_REGION       : ${region || '(unset)'}`);
  console.log(`  S3_BUCKET        : ${bucket || '(unset)'}`);
  console.log(`  AWS_ACCESS_KEY_ID: ${accessKey ? PASS + ' set' : FAIL + ' NOT SET'}`);
  console.log(`  AWS_SECRET_ACCESS: ${secretKey ? PASS + ' set' : FAIL + ' NOT SET'}`);
  console.log(`  MOCKS3           : ${mockMode}`);

  if (!accessKey || !secretKey) {
    log(FAIL, 'AWS credentials missing - cannot proceed');
    process.exit(1);
  }
  if (mockMode || provider === 'mock') {
    log(WARN, 'MOCKS3=true / STORAGE_PROVIDER=mock - test will use local mock, not real S3');
  }

  record('env-credentials', true, 'AWS credentials present');

  // ── Step 2: Load storage provider (same singleton the app uses) ──────────
  section('Step 2: Load Storage Provider (app singleton)');

  let storage;
  try {
    storage = require('../src/integrations/storage');
    log(PASS, `Storage provider loaded`, storage.providerName || typeof storage);
    record('provider-load', true, storage.providerName);
  } catch (err) {
    log(FAIL, 'Failed to load storage provider', err.message);
    record('provider-load', false, err.message);
    process.exit(1);
  }

  // ── Step 3: Verify followRegionRedirects is set ──────────────────────────
  section('Step 3: Verify followRegionRedirects Fix');

  const s3ProviderSrc = fs.readFileSync(
    path.join(__dirname, '../src/integrations/storage/S3StorageProvider.js'), 'utf8'
  );
  const awsS3Src = fs.readFileSync(
    path.join(__dirname, '../src/integrations/s3/awsS3.js'), 'utf8'
  );

  if (s3ProviderSrc.includes('followRegionRedirects: true')) {
    log(PASS, 'S3StorageProvider has followRegionRedirects: true');
    record('followRegionRedirects-provider', true);
  } else {
    log(FAIL, 'S3StorageProvider is MISSING followRegionRedirects: true');
    record('followRegionRedirects-provider', false);
  }

  if (awsS3Src.includes('followRegionRedirects: true')) {
    log(PASS, 'awsS3.js has followRegionRedirects: true');
    record('followRegionRedirects-legacy', true);
  } else {
    log(FAIL, 'awsS3.js is MISSING followRegionRedirects: true');
    record('followRegionRedirects-legacy', false);
  }

  // ── Step 4: Verify status-code guard in responseHelper ───────────────────
  section('Step 4: Verify 301 Status-Code Guard');

  const responseHelperSrc = fs.readFileSync(
    path.join(__dirname, '../src/common/helpers/responseHelper.js'), 'utf8'
  );
  const errorHandlerSrc = fs.readFileSync(
    path.join(__dirname, '../src/middleware/errorHandler.js'), 'utf8'
  );

  if (responseHelperSrc.includes('statusCode < 400')) {
    log(PASS, 'responseHelper.js guards against non-4xx/5xx status codes');
    record('responseHelper-guard', true);
  } else {
    log(FAIL, 'responseHelper.js is MISSING the status-code guard');
    record('responseHelper-guard', false);
  }

  if (errorHandlerSrc.includes('raw >= 400')) {
    log(PASS, 'errorHandler.js clamps status to 4xx/5xx range');
    record('errorHandler-guard', true);
  } else {
    log(FAIL, 'errorHandler.js is MISSING the status clamp');
    record('errorHandler-guard', false);
  }

  // ── Step 5: Verify S3StorageProvider maps 3xx → 502 ─────────────────────
  section('Step 5: Verify S3 Upload Error Maps 3xx → 502');

  if (s3ProviderSrc.includes('rawStatus < 300 || rawStatus >= 400')) {
    log(PASS, 'S3StorageProvider maps 3xx redirect errors to 502');
    record('s3-3xx-mapping', true);
  } else {
    log(FAIL, 'S3StorageProvider is MISSING the 3xx → 502 error mapping');
    record('s3-3xx-mapping', false);
  }

  // ── Step 6: getKey for maintenance ───────────────────────────────────────
  section('Step 6: Key Generation for Maintenance Documents');

  try {
    const testUserId = '507f1f77bcf86cd799439011';
    const key = storage.getKey('maintenance', 'test-document.pdf', testUserId);
    if (!key) throw new Error('getKey returned empty string');
    if (!key.includes('Maintenance')) throw new Error(`Key missing "Maintenance" folder: ${key}`);
    log(PASS, 'getKey("maintenance") generates correct key', key);
    record('getKey-maintenance', true, key);
  } catch (err) {
    log(FAIL, 'getKey("maintenance") failed', err.message);
    record('getKey-maintenance', false, err.message);
  }

  // ── Step 7: Actual S3 upload (simulates maintenance doc upload) ──────────
  section('Step 7: Live S3 Upload - Maintenance Folder');

  let uploadedKey = null;
  const tmpFile = createTempFile(
    `PropMv maintenance upload test\nTimestamp: ${new Date().toISOString()}\nBucket: ${bucket}\nRegion: ${region}`
  );

  try {
    const testUserId = 'test-user';
    const key = storage.getKey('maintenance', 'test-maintenance-doc.txt', testUserId);

    log(' ', 'Uploading to S3...', key);

    const result = await storage.upload({
      localFilePath: tmpFile,
      key,
      contentType: 'text/plain',
    });

    uploadedKey = result.Key || key;
    log(PASS, 'Upload succeeded');
    log(' ', 'Key     ', result.Key);
    log(' ', 'Location', result.Location);
    record('s3-upload', true, result.Key);

    // Verify no 301 in the result
    if (result.Location && result.Location.includes('301')) {
      log(WARN, 'Location URL looks suspicious - contains "301"');
    }

  } catch (err) {
    log(FAIL, 'Upload FAILED', err.message);
    log(' ', 'Error code  ', err.code || err.name || 'n/a');
    log(' ', 'HTTP status ', err.status || err.$metadata?.httpStatusCode || 'n/a');

    if (err.$metadata?.httpStatusCode === 301 || err.status === 301) {
      log(FAIL, '301 REDIRECT STILL OCCURRING - followRegionRedirects may not have taken effect');
      log(' ', 'This means the bucket region does not match AWS_REGION in .env');
      log(' ', `Current AWS_REGION: ${region}`);
      log(' ', 'Run: aws s3api get-bucket-location --bucket ' + bucket);
    }

    record('s3-upload', false, err.message);
    // Clean up temp file if upload failed (provider won't have deleted it)
    try { fs.unlinkSync(tmpFile); } catch (_) { }
  }

  // ── Step 8: Presigned URL generation ─────────────────────────────────────
  section('Step 8: Presigned URL Generation');

  if (uploadedKey) {
    try {
      const url = await storage.getPresignedUrl({ key: uploadedKey, expiresIn: 60 });
      if (!url || !url.startsWith('https://')) throw new Error('Invalid presigned URL: ' + url);
      log(PASS, 'Presigned URL generated successfully');
      log(' ', 'URL (truncated)', url.substring(0, 80) + '...');
      record('presigned-url', true);
    } catch (err) {
      log(FAIL, 'Presigned URL generation failed', err.message);
      record('presigned-url', false, err.message);
    }
  } else {
    log(WARN, 'Skipped - upload in Step 7 failed');
    record('presigned-url', false, 'skipped - upload failed');
  }

  // ── Step 9: Cleanup ───────────────────────────────────────────────────────
  section('Step 9: Cleanup');

  if (uploadedKey) {
    try {
      await storage.delete({ key: uploadedKey });
      log(PASS, 'Test file deleted from S3', uploadedKey);
      record('s3-delete', true);
    } catch (err) {
      log(WARN, 'Delete failed (non-critical)', err.message);
      record('s3-delete', false, err.message);
    }
  }

  // Clean up temp file if still exists
  try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) { }

  // ── Summary ───────────────────────────────────────────────────────────────
  section('Summary');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  results.forEach(r => {
    console.log(`  ${r.passed ? PASS : FAIL} ${r.name}${r.detail ? ' - ' + r.detail : ''}`);
  });

  console.log('');
  console.log(`  Total: ${results.length}  ${PASS} Passed: ${passed}  ${FAIL} Failed: ${failed}`);
  console.log('');

  if (failed === 0) {
    console.log('✓ All checks passed - the 301 issue is resolved.');
    console.log('  Document uploads to /api/v1/hoa/maintenance/request/:id/documents should work correctly.');
  } else {
    console.log('✗ Some checks failed - see details above.');
    const uploadFailed = results.find(r => r.name === 's3-upload' && !r.passed);
    if (uploadFailed) {
      console.log('');
      console.log('  Next steps:');
      console.log('  1. Confirm bucket region: aws s3api get-bucket-location --bucket ' + bucket);
      console.log('  2. Ensure AWS_REGION in .env.local matches the bucket region');
      console.log('  3. Confirm IAM user has s3:PutObject permission on the bucket');
    }
  }

  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
