#!/usr/bin/env node
/**
 * Ops: poll Hostinger IMAP for bounce DSNs and suppress bad recipients.
 *
 * Usage (from propmv/):
 *   node scripts/poll-email-bounces.js
 *
 * Requires EMAIL_BOUNCE_IMAP_ENABLED=true and SMTP/IMAP credentials in env.
 */
require('../src/config/loadEnv');

async function main() {
  process.env.EMAIL_BOUNCE_IMAP_ENABLED = process.env.EMAIL_BOUNCE_IMAP_ENABLED || 'true';

  const { connectDB } = require('../src/config/db.config');
  await connectDB();

  const { pollBounceMailboxOnce } = require('../src/common/helpers/emailBounceImapPoller.service');
  const result = await pollBounceMailboxOnce();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[poll-email-bounces] failed:', err.message || err);
  process.exit(1);
});
