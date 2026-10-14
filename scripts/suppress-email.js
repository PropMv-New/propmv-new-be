#!/usr/bin/env node
/**
 * Ops: manually suppress an email address (blocks future SMTP sends).
 *
 * Usage:
 *   node scripts/suppress-email.js bad@example.com "hostinger bounce 550 5.1.1"
 */
require('../src/config/loadEnv');

async function main() {
  const email = String(process.argv[2] || '').trim();
  const reason = String(process.argv[3] || 'manual_suppress').trim();
  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/suppress-email.js <email> [reason]');
    process.exit(2);
  }

  const { connectDB } = require('../src/config/db.config');
  await connectDB();

  const {
    recordPermanentBounce,
    normalizeEmail,
    isSyntaxValid,
  } = require('../src/common/helpers/emailRecipientValidation.service');

  const normalized = normalizeEmail(email);
  if (!isSyntaxValid(normalized)) {
    console.error('Invalid email syntax:', email);
    process.exit(2);
  }

  const doc = await recordPermanentBounce(normalized, {
    reason,
    bounceReason: reason,
    source: 'manual',
    context: 'ops_script_suppress',
  });

  console.log(JSON.stringify({ email: normalized, suppression: doc }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[suppress-email] failed:', err.message || err);
  process.exit(1);
});
