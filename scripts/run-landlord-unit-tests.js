#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 * File: run-landlord-unit-tests.js
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
 * Runs all landlord portal unit tests (validators, helpers, controllers).
 * Usage: node scripts/run-landlord-unit-tests.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const testFiles = [];

/**
 * collect
 *
 * Performs logic operations for collect.
 *
 * @param dir - Request/input argument
 * @returns Operations result
 */
function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.test.js')) testFiles.push(full);
  }
}

collect(path.join(root, 'src', 'tests', 'landlord'));

const legacyPatterns = [
  'landlord.invoice.status.test.js',
  'landlord.invoice.payment.test.js',
  'landlord.invoice.update.test.js',
  'landlord.invoiceId.test.js',
  'landlord.invoice.create.test.js',
  'landlord.invoice.model-isolation.test.js',
  'lateFeeInvoice.helpers.test.js',
  'depositRefundInvoice.helpers.test.js',
  'property.getPropertiesQuery.schema.test.js',
  'tenant.transactions.test.js',
  'invoice.transactions.test.js',
  'leaseTenantOnboardingEmails.test.js',
  'syndication.service.test.js',
];

for (const name of legacyPatterns) {
  const full = path.join(root, 'src', 'tests', name);
  if (fs.existsSync(full) && !testFiles.includes(full)) {
    testFiles.push(full);
  }
}

testFiles.sort();

if (testFiles.length === 0) {
  console.error('No landlord test files found.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} landlord test file(s)...`);

const result = spawnSync(
  process.execPath,
  ['--test', ...testFiles],
  { stdio: 'inherit', cwd: root },
);

process.exit(result.status ?? 1);
