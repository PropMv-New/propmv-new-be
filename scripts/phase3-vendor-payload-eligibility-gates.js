'use strict';

/**
 * Phase 3 — Vendor Pay readiness / eligibility gates (Atlas + Payload Sandbox).
 *
 * HARD RULE: creates ZERO Payload payment transactions (no POST /transactions).
 * Scope: eligibility resolver + safety flags only.
 *
 * Run: node scripts/phase3-vendor-payload-eligibility-gates.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const results = [];
let transactionPostCount = 0;

function record(gate, status, detail = {}) {
  results.push({ gate, status, ...detail });
  console.log(`\n[${status}] ${gate}`);
  if (detail.message) console.log(`  ${detail.message}`);
  if (detail.data) {
    console.log(`  ${JSON.stringify(detail.data, null, 2).split('\n').join('\n  ')}`);
  }
}

function writeResults(outcome) {
  const outPath = path.join(__dirname, '../docs/phase3-vendor-payload-eligibility-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    outcome,
    transactionPostsAttempted: transactionPostCount,
    results,
  }, null, 2));
  console.log(`\nWrote ${outPath} (outcome=${outcome})`);
}

async function main() {
  process.env.PAYLOAD_VENDOR_MERCHANT_ENABLED = 'true';
  // Phase 3 must NOT require PAYLOAD_VENDOR_PAY_ENABLED
  delete process.env.PAYLOAD_VENDOR_PAY_ENABLED;

  delete require.cache[require.resolve('../src/config/payload.config')];
  const payloadConfig = require('../src/config/payload.config');
  payloadConfig.payload.vendorMerchantEnabled = true;
  payloadConfig.payload.enabled = true;

  const { PayloadClient } = require('../src/shared/modules/payment/providers/payload/client/payload.client');
  const PayloadAccount = require('../src/shared/modules/payment/providers/payload/model/payloadAccount.model');
  const {
    PayloadDepositMethod,
  } = require('../src/shared/modules/payment/providers/payload/model/payloadDepositMethod.model');
  const PayloadPaymentMethod = require('../src/shared/modules/payment/providers/payload/model/payloadPaymentMethod.model');

  const client = new PayloadClient();

  // Instrument client: any transaction-like call fails the suite.
  const originalRequest = client._request.bind(client);
  client._request = async (opts = {}) => {
    const p = String(opts.path || '');
    const method = String(opts.method || '').toLowerCase();
    if (/\/transactions/i.test(p) || (method === 'post' && /payin|payment_intent/i.test(p))) {
      transactionPostCount += 1;
      throw new Error(`Phase 3 forbidden API call: ${method} ${p}`);
    }
    return originalRequest(opts);
  };

  if (!client.isConfigured()) {
    record('CONFIG', 'FAIL', { message: 'Payload client not configured' });
    writeResults('fail');
    process.exitCode = 1;
    return;
  }

  record('CONFIG', 'PASS', {
    message: 'Sandbox configured; vendorMerchantEnabled=true; PAYLOAD_VENDOR_PAY_ENABLED unset',
    data: {
      environment: payloadConfig.payload.environment,
      vendorMerchantEnabled: payloadConfig.payload.vendorMerchantEnabled,
      vendorPayEnabledEnv: process.env.PAYLOAD_VENDOR_PAY_ENABLED || null,
    },
  });

  const dbUrl = process.env.DB_URL || process.env.MONGODB_URI;
  if (!dbUrl) {
    record('ATLAS_CONNECT', 'BLOCKED', { message: 'DB_URL / MONGODB_URI missing' });
    writeResults('blocked');
    process.exitCode = 2;
    return;
  }

  try {
    await mongoose.connect(dbUrl, {
      dbName: process.env.DB_NAME || undefined,
      serverSelectionTimeoutMS: 12000,
      family: 4,
    });
    record('ATLAS_CONNECT', 'PASS', { message: 'Connected to Atlas / Mongo' });
  } catch (err) {
    record('ATLAS_CONNECT', 'BLOCKED', { message: `Atlas unreachable: ${err.message}` });
    writeResults('blocked');
    process.exitCode = 2;
    return;
  }

  const stamp = Date.now();
  const vendorUserId = new mongoose.Types.ObjectId();
  const otherVendorUserId = new mongoose.Types.ObjectId();
  const assigneeUserId = new mongoose.Types.ObjectId();
  const hoaOid = new mongoose.Types.ObjectId();
  const invoiceId = new mongoose.Types.ObjectId();

  // Stub VendorInvoice auth loader — avoid email ESM graph in gate runner.
  const vendorInvoiceServicePath = require.resolve(
    '../src/portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service',
  );
  const vendorInvoiceStub = {
    getVendorInvoiceById: async (id, actorId) => {
      const actor = String(actorId);
      if (actor !== String(vendorUserId) && actor !== String(assigneeUserId)) {
        const err = new Error('Access denied');
        err.status = 403;
        throw err;
      }
      return {
        _id: invoiceId,
        invoiceNumber: `VIN-P3-${stamp}`,
        status: 'Pending',
        balanceDue: 250,
        vendorId: vendorUserId,
        assignedTo: assigneeUserId,
        hoaId: hoaOid,
      };
    },
  };
  require.cache[vendorInvoiceServicePath] = {
    id: vendorInvoiceServicePath,
    filename: vendorInvoiceServicePath,
    loaded: true,
    exports: vendorInvoiceStub,
  };

  delete require.cache[require.resolve(
    '../src/shared/modules/payment/providers/payload/service/payloadVendorEligibility.service',
  )];
  const eligibility = require(
    '../src/shared/modules/payment/providers/payload/service/payloadVendorEligibility.service',
  );

  let accountDoc = null;
  let inactiveAccountDoc = null;
  let otherAccountDoc = null;
  let defaultBank = null;
  let otherBank = null;
  let vendorPaId = null;

  try {
    const pa = await client.createProcessingAccount({
      name: `PropMV Phase3 Vendor ${stamp}`,
      application_link: true,
      attrs: { propmv_phase3: 'eligibility', stamp: String(stamp) },
    });
    vendorPaId = pa?.id || null;
    record('SANDBOX_PA_READONLY', vendorPaId ? 'PASS' : 'FAIL', {
      message: vendorPaId
        ? 'Created Vendor PA for eligibility fixtures (no transactions)'
        : 'No PA id',
      data: { vendorPaId, status: pa?.status },
    });
  } catch (err) {
    record('SANDBOX_PA_READONLY', 'FAIL', { message: err.message });
  }

  try {
    if (!vendorPaId) throw new Error('Vendor PA required');

    accountDoc = await PayloadAccount.create({
      provider: 'PAYLOAD',
      entityType: 'vendor',
      entityId: vendorUserId,
      businessId: vendorUserId,
      createdBy: vendorUserId,
      merchantId: vendorPaId,
      onboardingStatus: 'ACTIVE',
      externalId: `payload_vendor_${vendorUserId}`,
      accountName: `Phase3 Vendor ${stamp}`,
      metadata: { propmvPhase3: true, stamp },
    });

    inactiveAccountDoc = await PayloadAccount.create({
      provider: 'PAYLOAD',
      entityType: 'vendor',
      entityId: new mongoose.Types.ObjectId(),
      businessId: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
      merchantId: `acct_inactive_${stamp}`,
      onboardingStatus: 'ONBOARDING',
      externalId: `payload_vendor_inactive_${stamp}`,
      accountName: `Phase3 Inactive ${stamp}`,
      metadata: { propmvPhase3: true, stamp },
    });

    otherAccountDoc = await PayloadAccount.create({
      provider: 'PAYLOAD',
      entityType: 'vendor',
      entityId: otherVendorUserId,
      businessId: otherVendorUserId,
      createdBy: otherVendorUserId,
      merchantId: `acct_other_${stamp}`,
      onboardingStatus: 'ACTIVE',
      externalId: `payload_vendor_${otherVendorUserId}`,
      accountName: `Phase3 Other Vendor ${stamp}`,
      metadata: { propmvPhase3: true, stamp },
    });

    record('ATLAS_FIXTURES', 'PASS', {
      message: 'Vendor ACTIVE + INCOMPLETE + other-Vendor accounts persisted',
      data: {
        activeId: String(accountDoc._id),
        inactiveId: String(inactiveAccountDoc._id),
        otherId: String(otherAccountDoc._id),
      },
    });
  } catch (err) {
    record('ATLAS_FIXTURES', 'FAIL', { message: err.message });
  }

  try {
    if (!accountDoc || !vendorPaId) throw new Error('Account/PA required for banks');

    const pm = await client.createPaymentMethod({
      type: 'bank_account',
      account_id: vendorPaId,
      account_holder: `Phase3 Vendor Bank ${stamp}`,
      transfer_type: 'receive-only',
      default_deposit_method: true,
      bank_account: {
        account_number: '1234567890',
        routing_number: '021000021',
        account_type: 'checking',
        account_class: 'business',
      },
    }, { idempotencyKey: `p3_bank_${stamp}` });

    defaultBank = await PayloadDepositMethod.create({
      provider: 'PAYLOAD',
      payloadAccountRef: accountDoc._id,
      businessId: accountDoc.businessId,
      entityType: 'vendor',
      entityId: accountDoc.entityId,
      merchantId: vendorPaId,
      depositMethodId: pm.id,
      status: 'ACTIVE',
      verificationStatus: String(pm.verification_status || 'verified').toLowerCase(),
      transferType: 'receive-only',
      defaultDepositMethod: true,
      isPrimaryPayout: true,
      routeType: 'PAYMENTS',
      methodType: 'ACH',
      last4: '7890',
      metadata: { propmvPhase3: true, stamp },
      createdBy: vendorUserId,
      updatedBy: vendorUserId,
      lastSyncedAt: new Date(),
    });

    otherBank = await PayloadDepositMethod.create({
      provider: 'PAYLOAD',
      payloadAccountRef: otherAccountDoc._id,
      businessId: otherAccountDoc.businessId,
      entityType: 'vendor',
      entityId: otherAccountDoc.entityId,
      merchantId: otherAccountDoc.merchantId,
      depositMethodId: `pm_other_vendor_${stamp}`,
      status: 'ACTIVE',
      verificationStatus: 'verified',
      transferType: 'receive-only',
      defaultDepositMethod: true,
      isPrimaryPayout: true,
      routeType: 'PAYMENTS',
      methodType: 'ACH',
      last4: '0001',
      metadata: { propmvPhase3: true, stamp },
      createdBy: otherVendorUserId,
      updatedBy: otherVendorUserId,
      lastSyncedAt: new Date(),
    });

    record('SANDBOX_DEFAULT_BANK', defaultBank?.depositMethodId ? 'PASS' : 'FAIL', {
      message: 'Default receive-only bank persisted for Vendor PA',
      data: {
        pm: defaultBank?.depositMethodId,
        default: defaultBank?.defaultDepositMethod,
        otherPm: otherBank?.depositMethodId,
      },
    });
  } catch (err) {
    record('SANDBOX_DEFAULT_BANK', 'FAIL', { message: err.message });
  }

  // Owner wallet PM fixture (read-only count path)
  try {
    await PayloadPaymentMethod.create({
      provider: 'PAYLOAD',
      userId: assigneeUserId,
      entityType: 'hoa',
      entityId: hoaOid,
      providerPaymentMethodId: `pm_owner_${stamp}`,
      status: 'ACTIVE',
      type: 'CARD',
      metadata: { propmvPhase3: true, stamp },
    });
    record('OWNER_PM_FIXTURE', 'PASS', { message: 'Owner HOA-scoped PM fixture created' });
  } catch (err) {
    record('OWNER_PM_FIXTURE', 'WARN', {
      message: `Owner PM fixture skipped/failed (eligibility still tested): ${err.message}`,
    });
  }

  try {
    // Gate: inactive PA blockers — temporarily point vendor account lookup at incomplete
    const originalFind = PayloadAccount.findOne.bind(PayloadAccount);
    PayloadAccount.findOne = async (query) => {
      if (query?.entityType === 'vendor' && query?.createdBy) {
        return inactiveAccountDoc;
      }
      return originalFind(query);
    };

    const inactiveResult = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });
    PayloadAccount.findOne = originalFind;

    const hasInactiveBlocker = inactiveResult.blockers.some(
      (b) => b.code === 'VENDOR_PA_NOT_ACTIVE' || b.code === 'VENDOR_PA_UNLINKED',
    );
    record('ELIGIBILITY_INACTIVE_PA', hasInactiveBlocker && !inactiveResult.electronicPayExecutable ? 'PASS' : 'FAIL', {
      message: 'Inactive/incomplete Vendor PA returns blockers; pay not executable',
      data: {
        blockers: inactiveResult.blockers.map((b) => b.code),
        electronicPayAvailable: inactiveResult.electronicPayAvailable,
        electronicPayExecutable: inactiveResult.electronicPayExecutable,
      },
    });
  } catch (err) {
    record('ELIGIBILITY_INACTIVE_PA', 'FAIL', { message: err.message });
  }

  try {
    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });

    const bankOk = result.destinationBank?.paymentMethodId === defaultBank?.depositMethodId
      && result.destinationBank?.isDefaultDepositMethod === true;
    record('ELIGIBILITY_DEFAULT_BANK', bankOk ? 'PASS' : 'FAIL', {
      message: bankOk
        ? 'Eligibility resolves Vendor default deposit bank'
        : 'Default bank mismatch',
      data: {
        expected: defaultBank?.depositMethodId,
        got: result.destinationBank,
        vendorProcessingAccountId: result.vendor?.processingAccountId,
      },
    });

    const isolationOk = result.destinationBank?.paymentMethodId !== otherBank?.depositMethodId
      && String(result.vendor?.payloadAccountId) === String(accountDoc._id);
    record('CROSS_VENDOR_ISOLATION', isolationOk ? 'PASS' : 'FAIL', {
      message: isolationOk
        ? 'Destination bank is Vendor-scoped; other Vendor pm_ not selected'
        : 'Cross-Vendor bank isolation breach',
      data: {
        selected: result.destinationBank?.paymentMethodId,
        otherVendorPm: otherBank?.depositMethodId,
      },
    });

    const ownerOk = result.ownerPayer?.evaluated === true
      && typeof result.ownerPayer?.eligiblePaymentMethodCount === 'number';
    record('OWNER_PAYER_READINESS', ownerOk ? 'PASS' : 'FAIL', {
      message: ownerOk
        ? 'Owner payer readiness resolved server-side'
        : 'Owner payer readiness not evaluated',
      data: result.ownerPayer,
    });

    record('ELECTRONIC_PAY_GATED', (
      result.electronicPayAvailable === false
      && result.electronicPayExecutable === false
      && result.brokenHoaPayinPathGated === true
      && result.manualRecordPaymentPreserved === true
    ) ? 'PASS' : 'FAIL', {
      message: 'Electronic pay never executable; broken HOA path gated; Record Payment preserved',
      data: {
        electronicPayAvailable: result.electronicPayAvailable,
        electronicPayExecutable: result.electronicPayExecutable,
        brokenHoaPayinPathGated: result.brokenHoaPayinPathGated,
        manualRecordPaymentPreserved: result.manualRecordPaymentPreserved,
        boardStrategy: result.boardCustomerStrategy?.status,
      },
    });

    record('NO_VENDOR_PAY_FLAG_REQUIRED', (
      !process.env.PAYLOAD_VENDOR_PAY_ENABLED
      && result.merchantModeEnabled === true
    ) ? 'PASS' : 'FAIL', {
      message: 'PAYLOAD_VENDOR_MERCHANT_ENABLED sufficient; PAYLOAD_VENDOR_PAY_ENABLED not introduced',
    });
  } catch (err) {
    record('ELIGIBILITY_DEFAULT_BANK', 'FAIL', { message: err.message });
    record('CROSS_VENDOR_ISOLATION', 'FAIL', { message: 'Skipped' });
    record('OWNER_PAYER_READINESS', 'FAIL', { message: 'Skipped' });
    record('ELECTRONIC_PAY_GATED', 'FAIL', { message: 'Skipped' });
    record('NO_VENDOR_PAY_FLAG_REQUIRED', 'FAIL', { message: 'Skipped' });
  }

  try {
    await assertRejectsUnauthorized();
    record('AUTH_MODEL_PRESERVED', 'PASS', {
      message: 'Eligibility refuses unrelated actor (existing VendorInvoice assignment auth)',
    });
  } catch (err) {
    record('AUTH_MODEL_PRESERVED', 'FAIL', { message: err.message });
  }

  async function assertRejectsUnauthorized() {
    try {
      await eligibility.getVendorInvoicePayEligibility({
        vendorInvoiceId: String(invoiceId),
        actorId: String(new mongoose.Types.ObjectId()),
      });
      throw new Error('Expected 403 for unrelated actor');
    } catch (err) {
      if (err.status !== 403 && err.statusCode !== 403) {
        throw err.message === 'Expected 403 for unrelated actor'
          ? err
          : new Error(`Expected 403, got ${err.status || err.statusCode}: ${err.message}`);
      }
    }
  }

  record('ZERO_TRANSACTIONS', transactionPostCount === 0 ? 'PASS' : 'FAIL', {
    message: transactionPostCount === 0
      ? 'Phase 3 gates created zero Payload payment transactions'
      : `Forbidden transaction posts detected: ${transactionPostCount}`,
    data: { transactionPostsAttempted: transactionPostCount },
  });

  // Cleanup Phase 3 fixtures (best-effort)
  try {
    await PayloadDepositMethod.deleteMany({ 'metadata.propmvPhase3': true, 'metadata.stamp': stamp });
    await PayloadAccount.deleteMany({ 'metadata.propmvPhase3': true, 'metadata.stamp': stamp });
    await PayloadPaymentMethod.deleteMany({ 'metadata.propmvPhase3': true, 'metadata.stamp': stamp });
  } catch {
    // ignore cleanup errors
  }

  await mongoose.disconnect().catch(() => {});

  const failed = results.some((r) => r.status === 'FAIL');
  const blocked = results.some((r) => r.status === 'BLOCKED');
  const outcome = failed ? 'fail' : blocked ? 'blocked' : 'pass';
  writeResults(outcome);
  process.exitCode = failed ? 1 : blocked ? 2 : 0;
}

main().catch((err) => {
  console.error(err);
  record('FATAL', 'FAIL', { message: err.message });
  writeResults('fail');
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
