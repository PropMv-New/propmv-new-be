#!/usr/bin/env node
/**
 * Ops: remove an email from the suppression list.
 *
 * Usage:
 *   node scripts/unsuppress-email.js user@example.com
 */
require('../src/config/loadEnv');

async function main() {
  const email = String(process.argv[2] || '').trim();
  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/unsuppress-email.js <email>');
    process.exit(2);
  }

  const { connectDB } = require('../src/config/db.config');
  await connectDB();

  const {
    normalizeEmail,
    isSyntaxValid,
  } = require('../src/common/helpers/emailRecipientValidation.service');

  const normalized = normalizeEmail(email);
  if (!isSyntaxValid(normalized)) {
    console.error('Invalid email syntax:', email);
    process.exit(2);
  }

  const EmailSuppression = require('../src/common/models/emailSuppression.model');
  const result = await EmailSuppression.deleteOne({ email: normalized });

  try {
    const { clearSmtpRcptVerifyCache } = require('../src/common/helpers/emailSmtpRcptVerify.service');
    clearSmtpRcptVerifyCache(normalized);
  } catch {
    /* ignore */
  }

  console.log(JSON.stringify({ email: normalized, removed: result.deletedCount > 0 }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[unsuppress-email] failed:', err.message || err);
  process.exit(1);
});
