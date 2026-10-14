#!/usr/bin/env node
/**
 * Ops: probe one address via SMTP RCPT (same check used before owner invites).
 *
 * Usage:
 *   node scripts/check-smtp-rcpt-verify.js nobody@gmail.com
 *
 * Loads .env.production when NODE_ENV=production, else .env.local / .env.
 */
const path = require('path');
const fs = require('fs');

function loadEnvFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new Error(`Refusing to load env file outside project root: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) return;
  const text = fs.readFileSync(resolved, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}

const root = path.join(__dirname, '..');
const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
loadEnvFile(path.join(root, isProd ? '.env.production' : '.env.local'));
loadEnvFile(path.join(root, '.env'));

process.env.EMAIL_SMTP_RCPT_VERIFY_ENABLED = 'true';
process.env.EMAIL_VALIDATION_LOG = 'false';
process.env.EMAIL_SUPPRESSION_ENABLED = 'false';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/check-smtp-rcpt-verify.js <email>');
  process.exit(2);
}

async function main() {
  const {
    lookupMx,
    extractDomain,
  } = require('../src/common/helpers/emailRecipientValidation.service');
  const {
    verifyMailboxViaSmtpRcpt,
  } = require('../src/common/helpers/emailSmtpRcptVerify.service');

  const domain = extractDomain(email);
  const mx = await lookupMx(domain);
  console.log(JSON.stringify({ email, domain, mxOk: mx.ok, mxRecords: mx.records?.slice(0, 5) }, null, 2));

  const result = await verifyMailboxViaSmtpRcpt(email, mx.records || []);
  console.log(JSON.stringify({ smtpRcpt: result }, null, 2));

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
