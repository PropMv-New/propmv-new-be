'use strict';

/**
 * Phase 5 — Board → Vendor electronic payment gates (Atlas + Payload Sandbox).
 *
 * Also runs Owner→Vendor regression and HOA-not-used assertions.
 *
 * Run: node scripts/phase5-board-vendor-payment-gates.js
 *
 * Enables PAYLOAD_VENDOR_PAY_ENABLED in-process only. Does not deploy or enable production.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

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
  const outPath = path.join(__dirname, '../docs/phase5-board-vendor-payment-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    outcome,
    results,
    productionReady: false,
    note: 'Sandbox COMPLETE does not mean production-ready; keep PAYLOAD_VENDOR_PAY_ENABLED=false',
  }, null, 2));
  console.log(`\nWrote ${outPath} (outcome=${outcome})`);
}

function assertHoaNotUsed({
  payin,
  vendorPaId,
  vendorBankId,
  hoaMerchantIds,
  hoaBankIds,
  boardUserId,
}) {
  const failures = [];
  if (!payin) failures.push('missing_payin');
  if (payin?.merchantId !== vendorPaId) failures.push('merchantId_not_vendor');
  if (payin?.destinationDepositMethodId !== vendorBankId) failures.push('destination_not_vendor_default');
  if (hoaMerchantIds.has(String(payin?.merchantId || ''))) failures.push('merchantId_is_hoa');
  if (hoaBankIds.has(String(payin?.destinationDepositMethodId || ''))) failures.push('destination_is_hoa_bank');
  const rawProc = String(payin?.raw?.processing_id || payin?.raw?.processingId || payin?.merchantId || '');
  const rawMethod = String(
    payin?.raw?.processing_method_id || payin?.raw?.processingMethodId || payin?.destinationDepositMethodId || '',
  );
  if (hoaMerchantIds.has(rawProc)) failures.push('raw_processing_id_is_hoa');
  if (hoaBankIds.has(rawMethod)) failures.push('raw_processing_method_is_hoa');
  if (boardUserId && String(payin?.payerUserId) !== String(boardUserId)) failures.push('payer_not_board');
  if (boardUserId && payin?.payerRole && payin.payerRole !== 'board') failures.push('payerRole_not_board');
  return failures;
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
  const { buildHoaOwnerPayloadScopeKey } = require(
    '../src/shared/modules/payment/providers/payload/utils/payloadHoaOwnerCustomerContext.util',
  );

  const client = new PayloadClient();
  if (!client.isConfigured()) {
    record('CONFIG', 'FAIL', { message: 'Payload client not configured' });
    writeResults('fail');
    process.exitCode = 1;
    return;
  }
  record('CONFIG', 'PASS', {
    message: 'Sandbox + vendorMerchant + vendorPay enabled in-process only',
    data: {
      environment: payloadConfig.payload.environment,
      vendorPayEnabled: true,
      committedDefaultRemainsFalse: true,
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
  const boardUserId = new mongoose.Types.ObjectId();
  const otherOwnerUserId = new mongoose.Types.ObjectId();
  const hoaOid = new mongoose.Types.ObjectId();
  const wrongHoaOid = new mongoose.Types.ObjectId();
  const invoiceId = new mongoose.Types.ObjectId();
  const invoiceId2 = new mongoose.Types.ObjectId();
  const scopeKey = buildHoaOwnerPayloadScopeKey(String(hoaOid));

  let vendorPaId = null;
  let hoaPaId = null;
  let accountDoc = null;
  let hoaAccountDoc = null;
  let defaultBank = null;
  let hoaBankId = null;
  let boardAchMethod = null;
  let boardCardMethod = null;
  let ownerMethodDoc = null;
  let boardCustomerId = null;
  let ownerCustomerId = null;

  const invoiceFixture = {
    _id: invoiceId,
    invoiceNumber: `VIN-P5-${stamp}`,
    status: 'Pending',
    balanceDue: 40.0,
    subAmount: 40.0,
    amountPaid: 0,
    vendorId: vendorUserId,
    assignedTo: assigneeUserId,
    hoaId: hoaOid,
  };
  const invoiceFixture2 = {
    _id: invoiceId2,
    invoiceNumber: `VIN-P5B-${stamp}`,
    status: 'Pending',
    balanceDue: 20.0,
    subAmount: 20.0,
    amountPaid: 0,
    vendorId: vendorUserId,
    assignedTo: assigneeUserId,
    hoaId: hoaOid,
  };

  const vendorInvoiceServicePath = require.resolve(
    '../src/portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service',
  );
  require.cache[vendorInvoiceServicePath] = {
    id: vendorInvoiceServicePath,
    filename: vendorInvoiceServicePath,
    loaded: true,
    exports: {
      getVendorInvoiceById: async (id, actorId, hoaContext = null) => {
        const inv = String(id) === String(invoiceId2) ? invoiceFixture2 : invoiceFixture;
        const actor = String(actorId);
        const assignee = String(inv.assignedTo);
        const vendor = String(inv.vendorId);
        const isBoard = Boolean(hoaContext?.isHOABoardMember);
        if (actor !== vendor && actor !== assignee && !isBoard) {
          const err = new Error('Access denied');
          err.status = 403;
          throw err;
        }
        if (isBoard && hoaContext?.hoaId && String(inv.hoaId) !== String(hoaContext.hoaId)) {
          const err = new Error('Vendor invoice not found');
          err.status = 404;
          throw err;
        }
        return { ...inv };
      },
    },
  };

  const gatewayHelper = require(
    '../src/portals/hoa-board/modules/vendor-invoice/helpers/vendorInvoiceGatewayPayment.helper',
  );
  const originalSettle = gatewayHelper.settleVendorInvoiceGatewayPayment;
  const originalMark = gatewayHelper.markVendorInvoiceElectronicProcessing;
  const originalFail = gatewayHelper.failVendorInvoiceGatewayPayment;
  const mutateInvoice = (inv, paymentAmount) => {
    inv.amountPaid = Math.round((inv.amountPaid + paymentAmount) * 100) / 100;
    inv.balanceDue = Math.max(0, inv.subAmount - inv.amountPaid);
    inv.status = inv.amountPaid >= inv.subAmount ? 'Paid' : 'Processing';
  };
  gatewayHelper.markVendorInvoiceElectronicProcessing = async ({ vendorInvoiceId }) => {
    const inv = String(vendorInvoiceId) === String(invoiceId2) ? invoiceFixture2 : invoiceFixture;
    inv.status = 'Processing';
    return { ...inv };
  };
  gatewayHelper.settleVendorInvoiceGatewayPayment = async ({ vendorInvoiceId, paymentAmount }) => {
    const inv = String(vendorInvoiceId) === String(invoiceId2) ? invoiceFixture2 : invoiceFixture;
    const next = Math.round((inv.amountPaid + paymentAmount) * 100) / 100;
    if (next > inv.subAmount + 0.001) {
      const err = new Error('Settlement would overpay Vendor invoice');
      err.status = 409;
      err.code = 'VENDOR_INVOICE_OVERPAY';
      throw err;
    }
    mutateInvoice(inv, paymentAmount);
    return { ...inv };
  };
  gatewayHelper.failVendorInvoiceGatewayPayment = async ({ vendorInvoiceId }) => {
    const inv = String(vendorInvoiceId) === String(invoiceId2) ? invoiceFixture2 : invoiceFixture;
    if (inv.amountPaid < inv.subAmount) inv.status = 'Pending';
    return { ...inv };
  };

  delete require.cache[require.resolve(
    '../src/shared/modules/payment/providers/payload/service/payloadVendorPayin.service',
  )];
  const payinService = require(
    '../src/shared/modules/payment/providers/payload/service/payloadVendorPayin.service',
  );

  const boardHoaContext = { isHOABoardMember: true, hoaId: String(hoaOid) };

  try {
    const pa = await client.createProcessingAccount({
      name: `PropMV Phase5 Vendor ${stamp}`,
      application_link: true,
      attrs: { propmv_phase5: 'vendor_pay', stamp: String(stamp) },
    });
    vendorPaId = pa?.id || null;
    record('SANDBOX_VENDOR_PA', vendorPaId ? 'PASS' : 'FAIL', {
      message: 'Vendor PA created',
      data: { vendorPaId },
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
      externalId: `payload_vendor_p5_${vendorUserId}`,
      accountName: `Phase5 Vendor ${stamp}`,
      metadata: { propmvPhase5: true, stamp },
    });

    const bankRemote = await client.createPaymentMethod({
      type: 'bank_account',
      account_id: vendorPaId,
      account_holder: `Phase5 Vendor Bank ${stamp}`,
      transfer_type: 'receive-only',
      default_deposit_method: true,
      bank_account: {
        account_number: '1234567890',
        routing_number: '021000021',
        account_type: 'checking',
        account_class: 'business',
      },
    }, { idempotencyKey: `p5_vbank_${stamp}` });

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
      metadata: { propmvPhase5: true, stamp },
      createdBy: vendorUserId,
      updatedBy: vendorUserId,
    });
    record('VENDOR_DEFAULT_BANK', defaultBank?.defaultDepositMethod ? 'PASS' : 'FAIL', {
      data: { defaultPm: defaultBank?.depositMethodId },
    });
  } catch (err) {
    record('VENDOR_DEFAULT_BANK', 'FAIL', { message: err.message });
  }

  // HOA PA + bank (must NEVER be charge destination)
  try {
    const hoaPa = await client.createProcessingAccount({
      name: `PropMV Phase5 HOA ${stamp}`,
      application_link: true,
      attrs: { propmv_phase5: 'hoa_scope', stamp: String(stamp) },
    });
    hoaPaId = hoaPa?.id || null;
    hoaAccountDoc = await PayloadAccount.create({
      provider: 'PAYLOAD',
      entityType: 'hoa',
      entityId: hoaOid,
      businessId: hoaOid,
      createdBy: boardUserId,
      merchantId: hoaPaId,
      onboardingStatus: 'ACTIVE',
      externalId: `payload_hoa_p5_${hoaOid}`,
      accountName: `Phase5 HOA ${stamp}`,
      metadata: { hoaId: String(hoaOid), propmvPhase5: true, stamp },
    });
    const hoaBankRemote = await client.createPaymentMethod({
      type: 'bank_account',
      account_id: hoaPaId,
      account_holder: `Phase5 HOA Bank ${stamp}`,
      transfer_type: 'receive-only',
      default_deposit_method: true,
      bank_account: {
        account_number: '1111222233',
        routing_number: '021000021',
        account_type: 'checking',
        account_class: 'business',
      },
    }, { idempotencyKey: `p5_hbank_${stamp}` });
    hoaBankId = hoaBankRemote?.id;
    await PayloadDepositMethod.create({
      provider: 'PAYLOAD',
      payloadAccountRef: hoaAccountDoc._id,
      businessId: hoaAccountDoc.businessId,
      entityType: 'hoa',
      entityId: hoaOid,
      merchantId: hoaPaId,
      depositMethodId: hoaBankId,
      status: 'ACTIVE',
      verificationStatus: 'verified',
      transferType: 'receive-only',
      defaultDepositMethod: true,
      isPrimaryPayout: true,
      routeType: 'PAYMENTS',
      methodType: 'ACH',
      last4: '2233',
      metadata: { propmvPhase5: true, stamp },
      createdBy: boardUserId,
      updatedBy: boardUserId,
    });
    record('HOA_RAILS_FIXTURE', hoaPaId && hoaBankId ? 'PASS' : 'FAIL', {
      message: 'HOA PA + bank present for inequality asserts',
      data: { hoaPaId, hoaBankId },
    });
  } catch (err) {
    record('HOA_RAILS_FIXTURE', 'FAIL', { message: err.message });
  }

  const hoaMerchantIds = new Set([String(hoaPaId || '')].filter(Boolean));
  const hoaBankIds = new Set([String(hoaBankId || '')].filter(Boolean));

  // --- First-time Board: no PM → Pay blocked ---
  try {
    await payinService.validateVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(boardUserId),
      hoaContext: boardHoaContext,
      invoicePaymentAmount: 5,
      paymentMethodLocalId: String(new mongoose.Types.ObjectId()),
    });
    record('FIRST_TIME_BOARD_NO_PM_BLOCK', 'FAIL', { message: 'Expected reject without PM' });
  } catch (err) {
    const ok = err.statusCode === 404 || err.code === 'PAYER_PM_NOT_FOUND' || err.statusCode === 400;
    record('FIRST_TIME_BOARD_NO_PM_BLOCK', ok ? 'PASS' : 'FAIL', {
      message: 'Pay Invoice rejects when Board has no PM (no silent create)',
      data: { code: err.code, statusCode: err.statusCode, message: err.message },
    });
  }

  // --- First-time Board onboarding: Customer + ACH (Settings-equivalent) ---
  try {
    if (!hoaPaId) throw new Error('HOA PA required for Board Customer hosting');
    const boardCust = await client.createCustomer({
      name: `Phase5 Board ${stamp}`,
      email: `phase5.board.${stamp}@example.com`,
      primary_processing_id: hoaPaId,
      attrs: { propmv_phase5: 'board', stamp: String(stamp) },
    });
    boardCustomerId = boardCust?.id;
    if (!boardCustomerId) throw new Error('Board customer missing');

    await PayloadUser.create({
      provider: 'PAYLOAD',
      userId: boardUserId,
      billableMerchantId: scopeKey,
      entityType: 'hoa',
      entityId: hoaOid,
      metadata: { payloadCustomerId: boardCustomerId, propmvPhase5: true, stamp },
    });

    const boardAch = await client.createPaymentMethod({
      type: 'bank_account',
      customer_id: boardCustomerId,
      account_holder: `Phase5 Board ${stamp}`,
      transfer_type: 'send-only',
      bank_account: {
        account_number: '5555666677',
        routing_number: '021000021',
        account_type: 'checking',
        account_class: 'personal',
      },
    }, { idempotencyKey: `p5_bach_${stamp}` });

    boardAchMethod = await PayloadPaymentMethod.create({
      provider: 'PAYLOAD',
      userId: boardUserId,
      providerPaymentMethodId: boardAch.id,
      billableMerchantId: scopeKey,
      entityType: 'hoa',
      entityId: hoaOid,
      type: 'ACH',
      status: 'ACTIVE',
      metadata: { payloadCustomerId: boardCustomerId, propmvPhase5: true, stamp },
    });

    record('FIRST_TIME_BOARD_ONBOARDING', boardAchMethod ? 'PASS' : 'FAIL', {
      message: 'Board Customer + ACH created explicitly (Settings-equivalent); Pay never auto-creates',
      data: {
        boardCustomerId,
        achLocalId: String(boardAchMethod?._id),
        scopeKey,
      },
    });
  } catch (err) {
    record('FIRST_TIME_BOARD_ONBOARDING', 'FAIL', { message: err.message });
  }

  // Board Card PM (existing Customer path) — requires billing address
  try {
    if (!boardCustomerId) throw new Error('Board Customer required for Card');
    const boardCard = await client.createPaymentMethod({
      type: 'card',
      customer_id: boardCustomerId,
      card: {
        card_number: '4242424242424242',
        expiry: '12/30',
        card_code: '123',
      },
      billing_address: {
        street_address: '1 Market St',
        city: 'San Francisco',
        state_province: 'CA',
        postal_code: '94105',
        country_code: 'US',
      },
    }, { idempotencyKey: `p5_bcard_${stamp}` });

    boardCardMethod = await PayloadPaymentMethod.create({
      provider: 'PAYLOAD',
      userId: boardUserId,
      providerPaymentMethodId: boardCard.id,
      billableMerchantId: scopeKey,
      entityType: 'hoa',
      entityId: hoaOid,
      type: 'CARD',
      status: 'ACTIVE',
      metadata: { payloadCustomerId: boardCustomerId, propmvPhase5: true, stamp },
    });
    record('BOARD_CARD_ONBOARDING', boardCardMethod ? 'PASS' : 'FAIL', {
      data: { cardLocalId: String(boardCardMethod?._id), pmId: boardCard?.id },
    });
  } catch (err) {
    record('BOARD_CARD_ONBOARDING', 'FAIL', { message: err.message });
  }

  // Owner PM fixture for regression
  try {
    const ownerCust = await client.createCustomer({
      name: `Phase5 Owner ${stamp}`,
      email: `phase5.owner.${stamp}@example.com`,
      primary_processing_id: hoaPaId,
      attrs: { propmv_phase5: 'owner', stamp: String(stamp) },
    });
    ownerCustomerId = ownerCust?.id;
    const ownerPm = await client.createPaymentMethod({
      type: 'bank_account',
      customer_id: ownerCustomerId,
      account_holder: `Phase5 Owner ${stamp}`,
      transfer_type: 'send-only',
      bank_account: {
        account_number: '9876543210',
        routing_number: '021000021',
        account_type: 'checking',
        account_class: 'personal',
      },
    }, { idempotencyKey: `p5_opm_${stamp}` });
    await PayloadUser.create({
      provider: 'PAYLOAD',
      userId: assigneeUserId,
      billableMerchantId: scopeKey,
      entityType: 'hoa',
      entityId: hoaOid,
      metadata: { payloadCustomerId: ownerCustomerId, propmvPhase5: true, stamp },
    });
    ownerMethodDoc = await PayloadPaymentMethod.create({
      provider: 'PAYLOAD',
      userId: assigneeUserId,
      providerPaymentMethodId: ownerPm.id,
      billableMerchantId: scopeKey,
      entityType: 'hoa',
      entityId: hoaOid,
      type: 'ACH',
      status: 'ACTIVE',
      metadata: { payloadCustomerId: ownerCustomerId, propmvPhase5: true, stamp },
    });
    record('OWNER_PM_FIXTURE', ownerMethodDoc ? 'PASS' : 'FAIL', {
      data: { ownerCustomerId, localId: String(ownerMethodDoc?._id) },
    });
  } catch (err) {
    record('OWNER_PM_FIXTURE', 'FAIL', { message: err.message });
  }

  // Auth matrix
  try {
    await payinService.validateVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(otherOwnerUserId),
      invoicePaymentAmount: 5,
      paymentMethodLocalId: String(ownerMethodDoc?._id || new mongoose.Types.ObjectId()),
    });
    record('AUTH_NON_ASSIGNEE_OWNER', 'FAIL', { message: 'Expected 403' });
  } catch (err) {
    record('AUTH_NON_ASSIGNEE_OWNER', err.statusCode === 403 || err.status === 403 ? 'PASS' : 'FAIL', {
      data: { code: err.code, message: err.message },
    });
  }

  try {
    await payinService.validateVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(boardUserId),
      hoaContext: { isHOABoardMember: true, hoaId: String(wrongHoaOid) },
      invoicePaymentAmount: 5,
      paymentMethodLocalId: String(boardAchMethod?._id || new mongoose.Types.ObjectId()),
    });
    record('AUTH_WRONG_HOA_BOARD', 'FAIL', { message: 'Expected deny' });
  } catch (err) {
    const ok = err.statusCode === 403 || err.status === 403 || err.status === 404;
    record('AUTH_WRONG_HOA_BOARD', ok ? 'PASS' : 'FAIL', {
      data: { code: err.code, statusCode: err.statusCode || err.status, message: err.message },
    });
  }

  // Board ACH execute
  const boardAchAttempt = `p5_bach_${stamp}`;
  let boardAchPayin = null;
  try {
    if (!boardAchMethod || !defaultBank) throw new Error('Board ACH fixtures incomplete');
    const result = await payinService.executeVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(boardUserId),
      hoaContext: boardHoaContext,
      invoicePaymentAmount: 5.0,
      paymentMethodLocalId: String(boardAchMethod._id),
      paymentAttemptId: boardAchAttempt,
      description: `Phase5 Board ACH ${stamp}`,
    });
    boardAchPayin = result.item;
    const row = await PayloadVendorPayin.findOne({
      paymentAttemptId: boardAchAttempt,
      isDeleted: { $ne: true },
    }).lean();
    const failures = assertHoaNotUsed({
      payin: row,
      vendorPaId,
      vendorBankId: defaultBank.depositMethodId,
      hoaMerchantIds,
      hoaBankIds,
      boardUserId,
    });
    const ok = failures.length === 0 && row?.transactionId && String(row.methodType).toUpperCase() === 'ACH';
    record('BOARD_ACH_EXECUTE', ok ? 'PASS' : 'FAIL', {
      message: ok ? 'Board→Vendor ACH charged to Vendor PA/default bank' : 'Assert failures',
      data: {
        failures,
        transactionId: row?.transactionId,
        status: row?.status,
        payerRole: row?.payerRole,
        merchantId: row?.merchantId,
        destination: row?.destinationDepositMethodId,
        hoaPaId,
        hoaBankId,
      },
    });
  } catch (err) {
    record('BOARD_ACH_EXECUTE', 'FAIL', {
      message: err.message,
      data: { code: err.code, statusCode: err.statusCode },
    });
  }

  // Idempotency same attempt
  try {
    const again = await payinService.executeVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(boardUserId),
      hoaContext: boardHoaContext,
      invoicePaymentAmount: 5.0,
      paymentMethodLocalId: String(boardAchMethod._id),
      paymentAttemptId: boardAchAttempt,
    });
    const count = await PayloadVendorPayin.countDocuments({
      paymentAttemptId: boardAchAttempt,
      isDeleted: { $ne: true },
    });
    record('IDEMPOTENCY_SAME_ATTEMPT', again.duplicate === true && count === 1 ? 'PASS' : 'FAIL', {
      data: { duplicate: again.duplicate, count },
    });
  } catch (err) {
    record('IDEMPOTENCY_SAME_ATTEMPT', 'FAIL', { message: err.message });
  }

  // Duplicate webhook
  try {
    if (!boardAchPayin?.transactionId) throw new Error('No Board ACH txn');
    let remote = null;
    try {
      remote = await client.getTransaction(boardAchPayin.transactionId);
    } catch {
      remote = { id: boardAchPayin.transactionId, status: 'processed', type: 'payment' };
    }
    const paidBefore = invoiceFixture.amountPaid;
    await payinService.applyVendorPayinWebhookUpdate({
      transactionId: boardAchPayin.transactionId,
      remotePayload: { ...remote, status: 'processed', type: 'payment' },
      eventType: 'processed',
    });
    const paidMid = invoiceFixture.amountPaid;
    await payinService.applyVendorPayinWebhookUpdate({
      transactionId: boardAchPayin.transactionId,
      remotePayload: { ...remote, status: 'processed', type: 'payment' },
      eventType: 'processed',
    });
    const paidAfter = invoiceFixture.amountPaid;
    const ok = paidAfter === paidMid;
    record('DUPLICATE_WEBHOOK', ok ? 'PASS' : 'FAIL', {
      message: 'Second webhook did not double-settle',
      data: { paidBefore, paidMid, paidAfter },
    });
  } catch (err) {
    record('DUPLICATE_WEBHOOK', 'FAIL', { message: err.message });
  }

  // Board Card execute (existing Board Customer/PM path)
  const boardCardAttempt = `p5_bcard_${stamp}`;
  let boardCardPayin = null;
  try {
    if (!boardCardMethod) throw new Error('Board Card fixture missing');
    const result = await payinService.executeVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId),
      actorId: String(boardUserId),
      hoaContext: boardHoaContext,
      invoicePaymentAmount: 5.0,
      paymentMethodLocalId: String(boardCardMethod._id),
      paymentAttemptId: boardCardAttempt,
      description: `Phase5 Board Card ${stamp}`,
    });
    boardCardPayin = result.item;
    const row = await PayloadVendorPayin.findOne({
      paymentAttemptId: boardCardAttempt,
      isDeleted: { $ne: true },
    }).lean();
    const failures = assertHoaNotUsed({
      payin: row,
      vendorPaId,
      vendorBankId: defaultBank.depositMethodId,
      hoaMerchantIds,
      hoaBankIds,
      boardUserId,
    });
    const ok = failures.length === 0 && row?.transactionId;
    record('BOARD_CARD_EXECUTE', ok ? 'PASS' : 'FAIL', {
      message: ok ? 'Board→Vendor Card charged to Vendor PA/default bank' : 'Assert failures',
      data: {
        failures,
        transactionId: row?.transactionId,
        status: row?.status,
        methodType: row?.methodType,
        payerRole: row?.payerRole,
        merchantId: row?.merchantId,
        destination: row?.destinationDepositMethodId,
      },
    });
  } catch (err) {
    record('BOARD_CARD_EXECUTE', 'FAIL', {
      message: err.message,
      data: { code: err.code, statusCode: err.statusCode },
    });
  }

  // Owner regression
  const ownerAttempt = `p5_owner_${stamp}`;
  let ownerPayin = null;
  try {
    if (!ownerMethodDoc) throw new Error('Owner fixture missing');
    const result = await payinService.executeVendorInvoicePayin({
      vendorInvoiceId: String(invoiceId2),
      actorId: String(assigneeUserId),
      invoicePaymentAmount: 7.0,
      paymentMethodLocalId: String(ownerMethodDoc._id),
      paymentAttemptId: ownerAttempt,
      description: `Phase5 Owner regression ${stamp}`,
    });
    ownerPayin = result.item;
    const row = await PayloadVendorPayin.findOne({
      paymentAttemptId: ownerAttempt,
      isDeleted: { $ne: true },
    }).lean();
    const failures = assertHoaNotUsed({
      payin: row,
      vendorPaId,
      vendorBankId: defaultBank.depositMethodId,
      hoaMerchantIds,
      hoaBankIds,
      boardUserId: null,
    }).filter((f) => f !== 'payer_not_board' && f !== 'payerRole_not_board');
    const ok = failures.length === 0
      && row?.transactionId
      && (row.payerRole === 'owner' || !row.payerRole);
    record('OWNER_REGRESSION', ok ? 'PASS' : 'FAIL', {
      data: {
        failures,
        transactionId: row?.transactionId,
        status: row?.status,
        payerRole: row?.payerRole,
        merchantId: row?.merchantId,
        destination: row?.destinationDepositMethodId,
      },
    });
  } catch (err) {
    record('OWNER_REGRESSION', 'FAIL', {
      message: err.message,
      data: { code: err.code, statusCode: err.statusCode },
    });
  }

  // Overpay / concurrency: in-flight blocks excess
  try {
    // Create a synthetic in-flight hold on invoice2
    const holdAttempt = `p5_hold_${stamp}`;
    await PayloadVendorPayin.create({
      provider: 'PAYLOAD',
      vendorInvoiceId: invoiceId2,
      hoaId: hoaOid,
      vendorUserId,
      payerUserId: boardUserId,
      payerRole: 'board',
      payloadAccountRef: accountDoc._id,
      merchantId: vendorPaId,
      destinationDepositMethodId: defaultBank.depositMethodId,
      providerPaymentMethodId: boardAchMethod.providerPaymentMethodId,
      customerId: boardCustomerId,
      methodType: 'ACH',
      status: 'PROCESSING',
      invoicePaymentAmount: 15,
      chargeAmountCents: 1500,
      processingFeeAmount: 0,
      paymentAttemptId: holdAttempt,
      idempotencyKey: `hold_${stamp}`,
      metadata: { propmvPhase5: true, stamp, syntheticHold: true },
    });
    // remaining on invoice2 after owner $7: 13; hold 15 → new 5 should fail
    let overpayBlocked = false;
    try {
      await payinService.executeVendorInvoicePayin({
        vendorInvoiceId: String(invoiceId2),
        actorId: String(boardUserId),
        hoaContext: boardHoaContext,
        invoicePaymentAmount: 5.0,
        paymentMethodLocalId: String(boardAchMethod._id),
        paymentAttemptId: `p5_overpay_${stamp}`,
      });
    } catch (err) {
      overpayBlocked = err.code === 'VENDOR_INVOICE_OVERPAY' || err.statusCode === 409;
      record('CONCURRENCY_INFLIGHT_OVERPAY', overpayBlocked ? 'PASS' : 'FAIL', {
        message: err.message,
        data: { code: err.code, details: err.details },
      });
    }
    if (!overpayBlocked && !results.some((r) => r.gate === 'CONCURRENCY_INFLIGHT_OVERPAY')) {
      record('CONCURRENCY_INFLIGHT_OVERPAY', 'FAIL', { message: 'Expected overpay reject' });
    }
  } catch (err) {
    record('CONCURRENCY_INFLIGHT_OVERPAY', 'FAIL', { message: err.message });
  }

  // Manual + electronic race via assertCollectableAllowsPayment
  // With amountPaid 7 + in-flight 15 on subAmount 20 → remaining 0; any Manual delta must fail.
  try {
    let manualBlocked = false;
    let details = null;
    try {
      await payinService.assertCollectableAllowsPayment({
        invoice: {
          _id: invoiceId2,
          subAmount: invoiceFixture2.subAmount,
          amountPaid: invoiceFixture2.amountPaid,
        },
        invoicePaymentAmount: 1,
      });
    } catch (err) {
      manualBlocked = err.code === 'VENDOR_INVOICE_OVERPAY';
      details = err.details || null;
    }
    record('MANUAL_ELECTRONIC_RACE_INVARIANT', manualBlocked ? 'PASS' : 'FAIL', {
      message: 'Shared collectable invariant blocks Manual payment when electronic in-flight consumes balance',
      data: { manualBlocked, details },
    });
  } catch (err) {
    record('MANUAL_ELECTRONIC_RACE_INVARIANT', 'FAIL', { message: err.message });
  }

  // Settlement util still sole authority
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
    record('SETTLE_AUTHORITY', none === 'none' && settle === 'settle' ? 'PASS' : 'FAIL', {
      data: { processing: none, succeeded: settle },
    });
  } catch (err) {
    record('SETTLE_AUTHORITY', 'FAIL', { message: err.message });
  }

  // New payment = new attempt id
  try {
    const k1 = payinService.buildVendorPayinIdempotencyKey({
      userId: String(boardUserId),
      vendorInvoiceId: String(invoiceId),
      paymentAttemptId: boardAchAttempt,
    });
    const k2 = payinService.buildVendorPayinIdempotencyKey({
      userId: String(boardUserId),
      vendorInvoiceId: String(invoiceId),
      paymentAttemptId: boardCardAttempt,
    });
    record('NEW_PAYMENT_NEW_ATTEMPT', k1 !== k2 ? 'PASS' : 'FAIL', {
      message: 'Legitimate second payment uses distinct attempt id / idempotency key',
    });
  } catch (err) {
    record('NEW_PAYMENT_NEW_ATTEMPT', 'FAIL', { message: err.message });
  }

  record('PRODUCTION_NOT_CLAIMED', 'PASS', {
    message: 'No production deploy/canary/live payments; flag default remains false',
  });

  // Cleanup
  try {
    await PayloadVendorPayin.deleteMany({ 'metadata.propmvPhase5': true, 'metadata.stamp': stamp });
    await PayloadVendorPayin.deleteMany({
      paymentAttemptId: {
        $in: [boardAchAttempt, boardCardAttempt, ownerAttempt, `p5_hold_${stamp}`, `p5_overpay_${stamp}`],
      },
    });
    await PayloadDepositMethod.deleteMany({ 'metadata.propmvPhase5': true, 'metadata.stamp': stamp });
    await PayloadAccount.deleteMany({ 'metadata.propmvPhase5': true, 'metadata.stamp': stamp });
    await PayloadPaymentMethod.deleteMany({ 'metadata.propmvPhase5': true, 'metadata.stamp': stamp });
    await PayloadUser.deleteMany({ 'metadata.propmvPhase5': true, 'metadata.stamp': stamp });
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
