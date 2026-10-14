#!/usr/bin/env node
/**
 * Runs the HOA invoice regression suite: payment allocation, credit balance,
 * reversal, helper logic, and related owner/invoice side effects.
 *
 * Usage: node scripts/run-hoa-invoice-regression-tests.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const testFiles = new Set();

function addIfExists(relativePath) {
  const full = path.join(root, relativePath);
  if (fs.existsSync(full)) testFiles.add(full);
}

function collectTestFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full);
    else if (entry.name.endsWith('.test.js')) testFiles.add(full);
  }
}

const invoiceHelperDir = path.join(
  root,
  'src/portals/hoa-board/modules/invoice/helpers',
);
collectTestFiles(invoiceHelperDir);
addIfExists(
  'src/portals/hoa-board/modules/invoice/service/invoicePaymentSourceGuard.integration.test.js',
);

const ownerInvoiceTests = [
  'src/portals/hoa-board/modules/owners/tests/ledgerChronologicalPayment.test.js',
  'src/portals/hoa-board/modules/owners/tests/invoiceEdgeCase.matrix.test.js',
  'src/portals/hoa-board/modules/owners/tests/ledgerCreditBalance.test.js',
  'src/portals/hoa-board/modules/owners/tests/ledgerCollectionStats.test.js',
  'src/portals/hoa-board/modules/owners/tests/unitInvoice.test.js',
  'src/portals/hoa-board/modules/owners/tests/unitInvoiceLabelSync.test.js',
  'src/portals/hoa-board/modules/owners/tests/invoiceScheduleMeta.test.js',
  'src/portals/hoa-board/modules/owners/tests/hoaInvoiceExtensionScheduler.test.js',
  'src/portals/hoa-board/modules/owners/tests/invoiceScheduleNotify.test.js',
  'src/portals/hoa-board/modules/owners/tests/unitLateFee.test.js',
  'src/portals/hoa-board/modules/owners/tests/ownerRemovalWaiveSettlement.test.js',
  'src/portals/hoa-board/modules/owners/helpers/ownerEligibility.helper.test.js',
  'src/portals/hoa-board/modules/owners/tests/ownerVerificationInvoiceGate.test.js',
];

for (const relativePath of ownerInvoiceTests) {
  addIfExists(relativePath);
}

const sharedInvoiceHelpers = [
  'src/common/helpers/invoicePaymentDate.helper.test.js',
  'src/common/helpers/hoaBillingDates.pastDueOutstanding.test.js',
  'src/common/helpers/hoaBillingDates.thisMonthRange.test.js',
  'src/common/helpers/invoiceLifecycleEmail.updated.test.js',
  'src/common/helpers/invoiceLifecycleEmail.paymentDeleted.test.js',
  'src/common/helpers/invoiceNotificationEmailHelper.test.js',
  'src/common/helpers/billingCalendar.test.js',
  'src/common/helpers/billingTimezone.constants.test.js',
  'src/common/helpers/paymentReminderConfig.helper.test.js',
  'src/common/helpers/paymentReminderAutomation.service.test.js',
  'src/portals/hoa-board/modules/invoice/service/invoiceActivityTimeline.builder.test.js',
];

for (const relativePath of sharedInvoiceHelpers) {
  addIfExists(relativePath);
}

const sorted = [...testFiles].sort();

if (sorted.length === 0) {
  console.error('No HOA invoice regression test files found.');
  process.exit(1);
}

console.log(`Running ${sorted.length} HOA invoice regression test file(s)...`);

const result = spawnSync(
  process.execPath,
  ['--test', ...sorted],
  { stdio: 'inherit', cwd: root },
);

process.exit(result.status ?? 1);
