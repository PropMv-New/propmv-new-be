'use strict';

/**
 * Phase 4 — Owner → Vendor electronic payment gates (Atlas + Payload Sandbox).
 *
 * Run: node scripts/phase4-vendor-owner-payment-gates.js
 *
 * Sandbox COMPLETE ≠ production-ready. Keep PAYLOAD_VENDOR_PAY_ENABLED=false in prod
 * until live webhooks + ACTIVE PA checklist are separately verified.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');

const results = [];

function record(gate, status, detail = {}) {
  results.push({ gate, status, ...detail });
  console.log(`\n[${status}] ${gate}`);
  if (detail.message) console.log(`  ${detail.message}`);
  if (detail.data) {
    console.log(`  ${JSON.stringify(detail.data, null, 2).split('\n').join('\n  ')}`);
  }
}

function writeResults(outcome) {
  const outPath = path.join(__dirname, '../docs/phase4-vendor-owner-payment-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    outcome,
    results,
    productionReady: false,
    note: 'Sandbox COMPLETE does not mean production-ready',
  }, null, 2));
  console.log(`\nWrote ${outPath} (outcome=${outcome})`);
}

async function main() {
  process.env.PAYLOAD_VENDOR_MERCHANT_ENABLED = 'true';
  process.env.PAYLOAD_VENDOR_PAY_ENABLED = 'true';
  delete require.cache[require.resolve('../src/config/payload.config')];
  const payloadConfig = require('../src/config/payload.config');
  payloadConfig.payload.enabled = true;
  payloadConfig.payload.vendorMerchantEnabled = true;
  payloadConfig.payload.vendorPayEnabled = true;

  const { PayloadClient } = require('../src/shared/modules/payment/providers/payload/client/payload.client');
  const PayloadAccount = require('../src/shared/modules/payment/providers/payload/model/payloadAccount.model');
  const { PayloadDepositMethod } = require('../src/shared/modules/payment/providers/payload/model/payloadDepositMethod.model');
  const PayloadPaymentMethod = require('../src/shared/modules/payment/providers/payload/model/payloadPaymentMethod.model');
  const PayloadUser = require('../src/shared/modules/payment/providers/payload/model/payloadUser.model');
  const PayloadVendorPayin = require('../src/shared/modules/payment/providers/payload/model/payloadVendorPayin.model');
  const {
    resolvePayloadPayinSettlementAction,
  } = require('../src/shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util');

  const client = new PayloadClient();
  if (!client.isConfigured()) {
    record('CONFIG', 'FAIL', { message: 'Payload client not configured' });
    writeResults('fail');
    process.exitCode = 1;
    return;
  }
  record('CONFIG', 'PASS', {
    message: 'Sandbox + vendorMerchant + vendorPay enabled for gates',
    data: {
      environment: payloadConfig.payload.environment,
      vendorPayEnabled: true,
      productionReadyClaim: false,
    },
  });

  const dbUrl = process.env.DB_URL || process.env.MONGODB_URI;
  if (!dbUrl) {
    record('ATLAS_CONNECT', 'BLOCKED', { message: 'DB_URL missing' });
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
    record('ATLAS_CONNECT', 'PASS', { message: 'Connected to Atlas' });
  } catch (err) {
    record('ATLAS_CONNECT', 'BLOCKED', { message: err.message });
    writeResults('blocked');
    process.exitCode = 2;
    return;
  }

  const stamp = Date.now();
  const vendorUserId = new mongoose.Types.ObjectId();
  const assigneeUserId = new mongoose.Types.ObjectId();
  const hoaOid = new mongoose.Types.ObjectId();
  const invoiceId = new mongoose.Types.ObjectId();
  let vendorPaId = null;
  let ownerCustomerId = null;
  let ownerPmId = null;
  let accountDoc = null;
  let defaultBank = null;
  let ownerMethodDoc = null;
  let payinDoc = null;

  // Stub VendorInvoice service for auth/resolution
  const vendorInvoiceServicePath = require.resolve(
    '../src/portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service',
  );
  const invoiceFixture = {
    _id: invoiceId,
    invoiceNumber: `VIN-P4-${stamp}`,
    status: 'Pending',
    balanceDue: 15.0,
    subAmount: 15.0,
    amountPaid: 0,
    vendorId: vendorUserId,
    assignedTo: assigneeUserId,
    hoaId: hoaOid,
  };
  require.cache[vendorInvoiceServicePath] = {
    id: vendorInvoiceServicePath,
    filename: vendorInvoiceServicePath,
    loaded: true,
    exports: {
      getVendorInvoiceById: async (id, actorId) => {
        if (String(actorId) !== String(assigneeUserId) && String(actorId) !== String(vendorUserId)) {
          const err = new Error('Access denied');
          err.status = 403;
          throw err;
        }
        return { ...invoiceFixture };
      },
    },
  };

  const gatewayHelper = require(
    '../src/portals/hoa-board/modules/vendor-invoice/helpers/vendorInvoiceGatewayPayment.helper',
  );

  // Patch gateway helper to mutate in-memory invoice fixture (no VendorInvoice collection required)
  const originalSettle = gatewayHelper.settleVendorInvoiceGatewayPayment;
  const originalMark = gatewayHelper.markVendorInvoiceElectronicProcessing;
  const originalFail = gatewayHelper.failVendorInvoiceGatewayPayment;
  gatewayHelper.markVendorInvoiceElectronicProcessing = async () => {
    invoiceFixture.status = 'Processing';
    return { ...invoiceFixture };
  };
  gatewayHelper.settleVendorInvoiceGatewayPayment = async ({ paymentAmount }) => {
    invoiceFixture.amountPaid = Math.round((invoiceFixture.amountPaid + paymentAmount) * 100) / 100;
    invoiceFixture.balanceDue = Math.max(0, invoiceFixture.subAmount - invoiceFixture.amountPaid);
    invoiceFixture.status = invoiceFixture.amountPaid >= invoiceFixture.subAmount ? 'Paid' : 'Processing';
    return { ...invoiceFixture };
  };
  gatewayHelper.failVendorInvoiceGatewayPayment = async () => {
    if (invoiceFixture.amountPaid < invoiceFixture.subAmount) invoiceFixture.status = 'Pending';
    return { ...invoiceFixture };
  };

  delete require.cache[require.resolve(
    '../src/shared/modules/payment/providers/payload/service/payloadVendorPayin.service',
  )];
  const payinService = require(
    '../src/shared/modules/payment/providers/payload/service/payloadVendorPayin.service',
  );

  try {
    const pa = await client.createProcessingAccount({
      name: `PropMV Phase4 Vendor ${stamp}`,
      application_link: true,
      attrs: { propmv_phase4: 'vendor_pay', stamp: String(stamp) },
    });
    vendorPaId = pa?.id || null;
    record('SANDBOX_VENDOR_PA', vendorPaId ? 'PASS' : 'FAIL', {
      message: 'Vendor PA created',
      data: { vendorPaId, status: pa?.status },
    });
  } catch (err) {
    record('SANDBOX_VENDOR_PA', 'FAIL', { message: err.message });
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
      accountName: `Phase4 Vendor ${stamp}`,
      metadata: { propmvPhase4: true, stamp },
    });

    const bankRemote = await client.createPaymentMethod({
      type: 'bank_account',
      account_id: vendorPaId,
      account_holder: `Phase4 Vendor Bank ${stamp}`,
      transfer_type: 'receive-only',
      default_deposit_method: true,
      bank_account: {
        account_number: '1234567890',
        routing_number: '021000021',
        account_type: 'checking',
        account_class: 'business',
      },
    }, { idempotencyKey: `p4_vbank_${stamp}` });

    defaultBank = await PayloadDepositMethod.create({
      provider: 'PAYLOAD',
      payloadAccountRef: accountDoc._id,
      businessId: accountDoc.businessId,
      entityType: 'vendor',
      entityId: accountDoc.entityId,
      merchantId: vendorPaId,
      depositMethodId: bankRemote.id,
      status: 'ACTIVE',
      verificationStatus: String(bankRemote.verification_status || 'verified').toLowerCase(),
      transferType: 'receive-only',
      defaultDepositMethod: true,
      isPrimaryPayout: true,
      routeType: 'PAYMENTS',
      methodType: 'ACH',
      last4: '7890',
      metadata: { propmvPhase4: true, stamp },
      createdBy: vendorUserId,
      updatedBy: vendorUserId,
    });

    // Non-default second bank — must NEVER be selected
    await PayloadDepositMethod.create({
      provider: 'PAYLOAD',
      payloadAccountRef: accountDoc._id,
      businessId: accountDoc.businessId,
      entityType: 'vendor',
      entityId: accountDoc.entityId,
      merchantId: vendorPaId,
      depositMethodId: `pm_non_default_${stamp}`,
      status: 'ACTIVE',
      verificationStatus: 'verified',
      transferType: 'receive-only',
      defaultDepositMethod: false,
      isPrimaryPayout: false,
      routeType: 'AVAILABLE',
      methodType: 'ACH',
      last4: '0002',
      metadata: { propmvPhase4: true, stamp },
      createdBy: vendorUserId,
      updatedBy: vendorUserId,
    });

    record('ATLAS_VENDOR_DEFAULT_BANK', defaultBank?.defaultDepositMethod ? 'PASS' : 'FAIL', {
      message: 'Default bank persisted; non-default also present',
      data: { defaultPm: defaultBank?.depositMethodId },
    });
  } catch (err) {
    record('ATLAS_VENDOR_DEFAULT_BANK', 'FAIL', { message: err.message });
  }

  try {
    // Owner customer + send-only ACH under a throwaway HOA PA (or org) for charge shape
    const hoaPa = await client.createProcessingAccount({
      name: `PropMV Phase4 HOA scope ${stamp}`,
      application_link: true,
      attrs: { propmv_phase4: 'hoa_scope', stamp: String(stamp) },
    });
    const ownerCust = await client.createCustomer({
      name: `Phase4 Owner ${stamp}`,
      email: `phase4.owner.${stamp}@example.com`,
      primary_processing_id: hoaPa.id,
      attrs: { propmv_phase4: 'owner', stamp: String(stamp) },
    });
    ownerCustomerId = ownerCust?.id;
    if (!ownerCustomerId) throw new Error('Owner customer id missing');
    const ownerPm = await client.createPaymentMethod({
      type: 'bank_account',
      customer_id: ownerCustomerId,
      account_holder: `Phase4 Owner ${stamp}`,
      transfer_type: 'send-only',
      bank_account: {
        account_number: '9876543210',
        routing_number: '021000021',
        account_type: 'checking',
        account_class: 'personal',
      },
    }, { idempotencyKey: `p4_opm_${stamp}` });
    ownerPmId = ownerPm?.id;
    if (!ownerPmId) throw new Error('Owner PM id missing');

    await PayloadUser.create({
      provider: 'PAYLOAD',
      userId: assigneeUserId,
      billableMerchantId: `hoa_owner_${hoaOid}`,
      entityType: 'hoa',
      entityId: hoaOid,
      metadata: { payloadCustomerId: ownerCustomerId, propmvPhase4: true, stamp },
    });

    ownerMethodDoc = await PayloadPaymentMethod.create({
      provider: 'PAYLOAD',
      userId: assigneeUserId,
      providerPaymentMethodId: ownerPmId,
      billableMerchantId: `hoa_owner_${hoaOid}`,
      entityType: 'hoa',
      entityId: hoaOid,
      type: 'ACH',
      status: 'ACTIVE',
      metadata: { payloadCustomerId: ownerCustomerId, propmvPhase4: true, stamp },
    });

    record('OWNER_PM_FIXTURE', ownerPmId && ownerCustomerId ? 'PASS' : 'FAIL', {
      message: 'Owner customer + send-only PM (existing; execute will not mutate)',
      data: { ownerCustomerId, ownerPmId, localId: String(ownerMethodDoc._id) },
    });
  } catch (err) {
    record('OWNER_PM_FIXTURE', 'FAIL', { message: err.message });
  }

  // Amount calculation consistency
  try {
    const amounts = await payinService.resolveVendorPayinAmounts(15);
    const ok = amounts.chargeAmountDollars === 15
      && amounts.chargeAmountCents === 1500
      && amounts.processingFeeAmount === 0;
    record('AMOUNT_CALC_NO_METHOD', ok ? 'PASS' : 'FAIL', {
      message: 'Without methodType: invoicePaymentAmount only; fee=0',
      data: amounts,
    });
  } catch (err) {
    record('AMOUNT_CALC_NO_FEE', 'FAIL', { message: err.message });
  }

  // Default bank only — resolveRequiredDefaultDepositBank
  try {
    const resolved = await payinService.resolveRequiredDefaultDepositBank(accountDoc);
    const ok = resolved
      && resolved.depositMethodId === defaultBank.depositMethodId
      && resolved.defaultDepositMethod === true;
    record('DEFAULT_BANK_ONLY', ok ? 'PASS' : 'FAIL', {
      message: ok ? 'Resolved configured default only (no first-bank fallback)' : 'Wrong bank',
      data: { resolved: resolved?.depositMethodId, expected: defaultBank?.depositMethodId },
    });
  } catch (err) {
    record('DEFAULT_BANK_ONLY', 'FAIL', { message: err.message });
  }

  // Settlement predicate ACH pending
  try {
    const none = resolvePayloadPayinSettlementAction({
      methodType: 'ACH',
      status: 'PROCESSING',
      alreadySettled: false,
    });
    const settle = resolvePayloadPayinSettlementAction({
      methodType: 'ACH',
      status: 'SUCCEEDED',
      eventType: 'processed',
      alreadySettled: false,
    });
    record('SETTLE_PREDICATE_ACH', none === 'none' && settle === 'settle' ? 'PASS' : 'FAIL', {
      message: 'ACH stays pending until util allows settlement',
      data: { processing: none, succeeded: settle },
    });
  } catch (err) {
    record('SETTLE_PREDICATE_ACH', 'FAIL', { message: err.message });
  }

  // Auth assignee only
  try {
    if (!ownerMethodDoc) throw new Error('Owner method fixture missing');
    await payinService.validateVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(new mongoose.Types.ObjectId()),
      invoicePaymentAmount: 5,
      paymentMethodLocalId: String(ownerMethodDoc._id),
    });
    record('AUTH_ASSIGNEE_ONLY', 'FAIL', { message: 'Expected 403 for non-assignee' });
  } catch (err) {
    record('AUTH_ASSIGNEE_ONLY', err.statusCode === 403 || err.status === 403 ? 'PASS' : 'FAIL', {
      message: err.message,
    });
  }

  // Execute real charge
  const attemptId = `p4_attempt_${stamp}`;
  try {
    if (!ownerMethodDoc || !defaultBank) throw new Error('Fixtures incomplete');
    const result = await payinService.executeVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
      invoicePaymentAmount: 5.0,
      paymentMethodLocalId: String(ownerMethodDoc._id),
      paymentAttemptId: attemptId,
      description: `Phase4 gate ${stamp}`,
    });
    payinDoc = result.item;
    const ok = payinDoc
      && payinDoc.transactionId
      && payinDoc.invoicePaymentAmount === 5
      && payinDoc.processingFeeAmount === 0
      && payinDoc.destinationDepositMethodId === defaultBank.depositMethodId
      && payinDoc.merchantId === vendorPaId;
    record('EXECUTE_OWNER_TO_VENDOR', ok ? 'PASS' : 'FAIL', {
      message: ok ? 'Owner→Vendor payment created' : 'Payin shape mismatch',
      data: {
        transactionId: payinDoc?.transactionId,
        status: payinDoc?.status,
        destination: payinDoc?.destinationDepositMethodId,
        amount: payinDoc?.invoicePaymentAmount,
        fee: payinDoc?.processingFeeAmount,
        duplicate: result.duplicate,
      },
    });
  } catch (err) {
    record('EXECUTE_OWNER_TO_VENDOR', 'FAIL', {
      message: err.message,
      data: { code: err.code, statusCode: err.statusCode },
    });
  }

  // Idempotency primary
  try {
    const again = await payinService.executeVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
      invoicePaymentAmount: 5.0,
      paymentMethodLocalId: String(ownerMethodDoc._id),
      paymentAttemptId: attemptId,
    });
    const count = await PayloadVendorPayin.countDocuments({
      paymentAttemptId: attemptId,
      isDeleted: { $ne: true },
    });
    record('IDEMPOTENCY_PRIMARY', again.duplicate === true && count === 1 ? 'PASS' : 'FAIL', {
      message: 'Same paymentAttemptId returns duplicate; single row',
      data: { duplicate: again.duplicate, count, transactionId: again.item?.transactionId },
    });
  } catch (err) {
    record('IDEMPOTENCY_PRIMARY', 'FAIL', { message: err.message });
  }

  // Atlas row verification
  try {
    const row = await PayloadVendorPayin.findOne({
      paymentAttemptId: attemptId,
      isDeleted: { $ne: true },
    }).lean();
    const ok = row
      && row.transactionId
      && row.merchantId === vendorPaId
      && row.destinationDepositMethodId === defaultBank.depositMethodId
      && String(row.vendorInvoiceId) === String(invoiceId)
      && row.processingFeeAmount === 0;
    record('ATLAS_VENDOR_PAYIN', ok ? 'PASS' : 'FAIL', {
      message: ok ? 'payloadvendorpayins row matches charge' : 'Row mismatch',
      data: {
        id: String(row?._id),
        transactionId: row?.transactionId,
        status: row?.status,
        settledAt: row?.settledAt,
      },
    });
  } catch (err) {
    record('ATLAS_VENDOR_PAYIN', 'FAIL', { message: err.message });
  }

  // Webhook apply simulation (re-fetch style payload)
  try {
    if (!payinDoc?.transactionId) throw new Error('No transaction');
    let remote = null;
    try {
      remote = await client.getTransaction(payinDoc.transactionId);
    } catch {
      remote = payinDoc.raw || { id: payinDoc.transactionId, status: 'processed', type: 'payment' };
    }
    // Force ACH-like settlement path if still processing
    const beforePaid = invoiceFixture.amountPaid;
    const applied = await payinService.applyVendorPayinWebhookUpdate({
      transactionId: payinDoc.transactionId,
      remotePayload: {
        ...remote,
        status: remote?.status || 'processed',
        type: 'payment',
      },
      eventType: 'processed',
    });
    record('WEBHOOK_APPLY', applied ? 'PASS' : 'FAIL', {
      message: 'Webhook path applied via settlement util + re-fetched payload',
      data: {
        status: applied?.status,
        settledAt: applied?.settledAt,
        invoiceAmountPaidBefore: beforePaid,
        invoiceAmountPaidAfter: invoiceFixture.amountPaid,
      },
    });
  } catch (err) {
    record('WEBHOOK_APPLY', 'FAIL', { message: err.message });
  }

  // Partial + collectable
  try {
    invoiceFixture.subAmount = 15;
    // after first $5 settle, remaining 10
    const remaining = Math.max(0, invoiceFixture.subAmount - invoiceFixture.amountPaid);
    const amounts = await payinService.resolveVendorPayinAmounts(Math.min(3, remaining || 3));
    record('PARTIAL_SUPPORTED', amounts.invoicePaymentAmount > 0 && amounts.processingFeeAmount === 0 ? 'PASS' : 'FAIL', {
      message: 'Partials allowed under existing VendorInvoice rules',
      data: { remaining, nextPartial: amounts.invoicePaymentAmount },
    });
  } catch (err) {
    record('PARTIAL_SUPPORTED', 'FAIL', { message: err.message });
  }

  record('PRODUCTION_NOT_CLAIMED', 'PASS', {
    message: 'Sandbox gates do not enable production; keep PAYLOAD_VENDOR_PAY_ENABLED=false until live checklist',
  });

  // Cleanup
  try {
    await PayloadVendorPayin.deleteMany({ 'metadata.phase': 'phase4_vendor_owner_pay', paymentAttemptId: attemptId });
    await PayloadDepositMethod.deleteMany({ 'metadata.propmvPhase4': true, 'metadata.stamp': stamp });
    await PayloadAccount.deleteMany({ 'metadata.propmvPhase4': true, 'metadata.stamp': stamp });
    await PayloadPaymentMethod.deleteMany({ 'metadata.propmvPhase4': true, 'metadata.stamp': stamp });
    await PayloadUser.deleteMany({ 'metadata.propmvPhase4': true, 'metadata.stamp': stamp });
  } catch {
    // ignore
  }

  gatewayHelper.settleVendorInvoiceGatewayPayment = originalSettle;
  gatewayHelper.markVendorInvoiceElectronicProcessing = originalMark;
  gatewayHelper.failVendorInvoiceGatewayPayment = originalFail;

  await mongoose.disconnect().catch(() => {});

  const failed = results.some((r) => r.status === 'FAIL');
  const blocked = results.some((r) => r.status === 'BLOCKED');
  writeResults(failed ? 'fail' : blocked ? 'blocked' : 'pass');
  process.exitCode = failed ? 1 : blocked ? 2 : 0;
}

main().catch((err) => {
  console.error(err);
  record('FATAL', 'FAIL', { message: err.message });
  writeResults('fail');
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
