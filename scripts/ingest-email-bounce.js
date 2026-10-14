#!/usr/bin/env node
/**
 * Ops: ingest a bounce DSN from a file or stdin and suppress the recipient.
 *
 * Usage:
 *   node scripts/ingest-email-bounce.js path/to/bounce.txt
 *   cat bounce.txt | node scripts/ingest-email-bounce.js
 */
require('../src/config/loadEnv');
const fs = require('fs');
const path = require('path');

function safeReadFile(filePath) {
  const resolved = path.resolve(filePath);
  const allowedRoot = process.cwd();
  if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
    console.error(`[ingest-email-bounce] Refusing to read file outside working directory: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf8');
}

async function main() {
  const { connectDB } = require('../src/config/db.config');
  await connectDB();

  let text = '';
  const filePath = process.argv[2];
  if (filePath) {
    text = safeReadFile(filePath);
  } else if (!process.stdin.isTTY) {
    text = fs.readFileSync(0, 'utf8');
  } else {
    console.error('Provide a bounce file path or pipe DSN text via stdin.');
    process.exit(1);
  }

  const { ingestBounceNotification } = require('../src/common/helpers/emailBounceIngest.service');
  const result = await ingestBounceNotification({
    subject: 'Manual bounce ingest',
    text,
    source: 'ops_script',
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.suppressed || result.email ? 0 : 2);
}

main().catch((err) => {
  console.error('[ingest-email-bounce] failed:', err.message || err);
  process.exit(1);
});
