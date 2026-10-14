'use strict';

/**
 * Phase 3 — Vendor pay readiness / eligibility (read-only).
 * These tests must never create Payload payment transactions.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('path');
const Module = require('module');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../../../../../.env') });
} catch {
  // optional
}

const vendorInvoiceServicePath = require.resolve(
  '../../../../../../portals/hoa-board/modules/vendor-invoice/service/vendorInvoice.service',
);

const vendorUserId = new mongoose.Types.ObjectId();
const assigneeUserId = new mongoose.Types.ObjectId();
const hoaId = new mongoose.Types.ObjectId();
const invoiceId = new mongoose.Types.ObjectId();
const accountId = new mongoose.Types.ObjectId();
const bankId = new mongoose.Types.ObjectId();

const vendorInvoiceStub = {
  getVendorInvoiceById: async () => {
    throw new Error('getVendorInvoiceById stub not configured');
  },
};

function installVendorInvoiceStub() {
  require.cache[vendorInvoiceServicePath] = {
    id: vendorInvoiceServicePath,
    filename: vendorInvoiceServicePath,
    loaded: true,
    exports: vendorInvoiceStub,
  };
}

describe('payloadVendorEligibility Phase 3', () => {
  let payloadConfig;
  let eligibility;
  let originalVendorFlag;
  let originalVendorPayFlag;
  let originalEnabled;
  let PayloadAccount;
  let PayloadDepositMethod;
  let PayloadPaymentMethod;
  let originalAccountFindOne;
  let originalDepositFindOne;
  let originalPmCount;
  let originalLoad;

  beforeEach(() => {
    installVendorInvoiceStub();
    // Prevent accidental real load of vendor-invoice ESM graph
    originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (
        typeof request === 'string'
        && request.includes('vendor-invoice/service/vendorInvoice.service')
      ) {
        return vendorInvoiceStub;
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[require.resolve('../../../../../../config/payload.config')];
    delete require.cache[require.resolve('./payloadVendorEligibility.service')];

    payloadConfig = require('../../../../../../config/payload.config');
    originalVendorFlag = payloadConfig.payload.vendorMerchantEnabled;
    originalEnabled = payloadConfig.payload.enabled;
    originalVendorPayFlag = payloadConfig.payload.vendorPayEnabled;
    // Deterministic: these readiness tests assert pay-flag-OFF behavior regardless of local .env.
    payloadConfig.payload.vendorMerchantEnabled = true;
    payloadConfig.payload.enabled = true;
    payloadConfig.payload.vendorPayEnabled = false;

    eligibility = require('./payloadVendorEligibility.service');
    PayloadAccount = require('../model/payloadAccount.model');
    ({ PayloadDepositMethod } = require('../model/payloadDepositMethod.model'));
    PayloadPaymentMethod = require('../model/payloadPaymentMethod.model');

    originalAccountFindOne = PayloadAccount.findOne;
    originalDepositFindOne = PayloadDepositMethod.findOne;
    originalPmCount = PayloadPaymentMethod.countDocuments;
  });

  afterEach(() => {
    Module._load = originalLoad;
    payloadConfig.payload.vendorMerchantEnabled = originalVendorFlag;
    payloadConfig.payload.enabled = originalEnabled;
    payloadConfig.payload.vendorPayEnabled = originalVendorPayFlag;
    PayloadAccount.findOne = originalAccountFindOne;
    PayloadDepositMethod.findOne = originalDepositFindOne;
    PayloadPaymentMethod.countDocuments = originalPmCount;
    delete require.cache[vendorInvoiceServicePath];
  });

  function mockInvoice(overrides = {}) {
    vendorInvoiceStub.getVendorInvoiceById = async () => ({
      _id: invoiceId,
      invoiceNumber: 'VIN-P3-001',
      status: 'Pending',
      balanceDue: 100,
      vendorId: vendorUserId,
      assignedTo: assigneeUserId,
      hoaId,
      ...overrides,
    });
  }

  function mockActiveVendorAccount(overrides = {}) {
    PayloadAccount.findOne = async () => ({
      _id: accountId,
      entityType: 'vendor',
      createdBy: vendorUserId,
      merchantId: 'acct_vendor_active',
      onboardingStatus: 'ACTIVE',
      ...overrides,
    });
  }

  function mockDefaultBank(overrides = {}) {
    const bank = {
      _id: bankId,
      payloadAccountRef: accountId,
      depositMethodId: 'pm_vendor_default',
      defaultDepositMethod: true,
      isPrimaryPayout: true,
      status: 'ACTIVE',
      verificationStatus: 'verified',
      transferType: 'receive-only',
      last4: '6789',
      bankName: 'Test Bank',
      ...overrides,
    };
    PayloadDepositMethod.findOne = () => ({
      sort: async () => bank,
    });
    return bank;
  }

  it('isDepositBankEligible rejects send-only and failed verification', () => {
    assert.equal(eligibility.isDepositBankEligible(null).ok, false);
    assert.equal(
      eligibility.isDepositBankEligible({
        depositMethodId: 'pm_x',
        status: 'ACTIVE',
        transferType: 'send-only',
      }).ok,
      false,
    );
    assert.equal(
      eligibility.isDepositBankEligible({
        depositMethodId: 'pm_x',
        status: 'ACTIVE',
        verificationStatus: 'failed',
        transferType: 'receive-only',
      }).ok,
      false,
    );
    assert.equal(
      eligibility.isDepositBankEligible({
        depositMethodId: 'pm_ok',
        status: 'ACTIVE',
        verificationStatus: 'verified',
        transferType: 'receive-only',
      }).ok,
      true,
    );
  });

  it('boardCustomerResolutionStrategy is active reuse of HOA-scoped wallet', () => {
    const strategy = eligibility.boardCustomerResolutionStrategy();
    assert.equal(strategy.status, 'active');
    assert.equal(strategy.phase3CreatesInfrastructure, false);
    assert.equal(strategy.recommendedPattern, 'reuse_ensurePayloadUserContext_hoa_scoped');
    assert.match(strategy.summary, /ensurePayloadUserContext/);
  });

  it('returns VENDOR_PA_NOT_ACTIVE blocker for incomplete Processing Account', async () => {
    mockInvoice();
    mockActiveVendorAccount({ onboardingStatus: 'ONBOARDING', merchantId: 'acct_incomplete' });
    mockDefaultBank();
    PayloadPaymentMethod.countDocuments = async () => 0;

    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });

    assert.equal(result.electronicPayAvailable, false);
    assert.equal(result.electronicPayExecutable, false);
    assert.equal(result.brokenHoaPayinPathGated, true);
    assert.equal(result.manualRecordPaymentPreserved, true);
    assert.ok(result.blockers.some((b) => b.code === 'VENDOR_PA_NOT_ACTIVE'));
    assert.ok(['phase3_readiness_only', 'phase4_pay_enabled'].includes(result.phase));
  });

  it('resolves Vendor default deposit bank and reports destinationBank', async () => {
    mockInvoice();
    mockActiveVendorAccount();
    const bank = mockDefaultBank({ depositMethodId: 'pm_default_abc' });
    PayloadPaymentMethod.countDocuments = async () => 1;

    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });

    assert.equal(result.destinationBank?.paymentMethodId, bank.depositMethodId);
    assert.equal(result.destinationBank?.isDefaultDepositMethod, true);
    assert.equal(result.vendor?.processingAccountId, 'acct_vendor_active');
    assert.ok(result.electronicPayReady);
    assert.equal(result.electronicPayExecutable, false);
  });

  it('blocks when Vendor bank is missing', async () => {
    mockInvoice();
    mockActiveVendorAccount();
    PayloadDepositMethod.findOne = () => ({
      sort: async () => null,
    });
    PayloadPaymentMethod.countDocuments = async () => 1;

    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });

    assert.ok(result.blockers.some((b) => b.code === 'VENDOR_DEFAULT_BANK_MISSING'));
    assert.equal(result.destinationBank, null);
    assert.equal(result.electronicPayReady, false);
  });

  it('resolves Owner payer readiness server-side for assignee', async () => {
    mockInvoice();
    mockActiveVendorAccount();
    mockDefaultBank();
    PayloadPaymentMethod.countDocuments = async () => 2;

    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });

    assert.equal(result.ownerPayer.evaluated, true);
    assert.equal(result.ownerPayer.ready, true);
    assert.equal(result.ownerPayer.eligiblePaymentMethodCount, 2);
  });

  it('reports OWNER_NO_PAYMENT_METHOD when assignee has no PMs', async () => {
    mockInvoice();
    mockActiveVendorAccount();
    mockDefaultBank();
    PayloadPaymentMethod.countDocuments = async () => 0;

    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });

    assert.equal(result.ownerPayer.evaluated, true);
    assert.equal(result.ownerPayer.ready, false);
    assert.ok(result.ownerPayer.blockers.some((b) => b.code === 'OWNER_NO_PAYMENT_METHOD'));
    assert.equal(result.electronicPayReady, false);
  });

  it('does not evaluate Owner payer when actor is Vendor (not assignee)', async () => {
    mockInvoice();
    mockActiveVendorAccount();
    mockDefaultBank();
    let counted = false;
    PayloadPaymentMethod.countDocuments = async () => {
      counted = true;
      return 0;
    };

    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(vendorUserId),
    });

    assert.equal(result.ownerPayer.evaluated, false);
    assert.equal(counted, false);
    assert.equal(result.electronicPayAvailable, false);
  });

  it('gates electronic path when merchant mode disabled', async () => {
    payloadConfig.payload.vendorMerchantEnabled = false;
    mockInvoice();

    const result = await eligibility.getVendorInvoicePayEligibility({
      vendorInvoiceId: String(invoiceId),
      actorId: String(assigneeUserId),
    });

    assert.equal(result.merchantModeEnabled, false);
    assert.equal(result.brokenHoaPayinPathGated, false);
    assert.ok(result.blockers.some((b) => b.code === 'VENDOR_MERCHANT_DISABLED'));
    assert.equal(result.electronicPayAvailable, false);
  });

  it('preserves VendorInvoice auth by delegating to getVendorInvoiceById', async () => {
    let seenActor = null;
    vendorInvoiceStub.getVendorInvoiceById = async (id, actorId) => {
      seenActor = String(actorId);
      const err = new Error('Access denied');
      err.status = 403;
      throw err;
    };

    await assert.rejects(
      () => eligibility.getVendorInvoicePayEligibility({
        vendorInvoiceId: String(invoiceId),
        actorId: String(new mongoose.Types.ObjectId()),
      }),
      (err) => err.status === 403,
    );
    assert.ok(seenActor);
  });

  it('assertVendorReadyToCreateInvoice blocks when bank account is missing', async () => {
    mockActiveVendorAccount();
    PayloadDepositMethod.findOne = () => ({
      sort: async () => null,
    });

    await assert.rejects(
      () => eligibility.assertVendorReadyToCreateInvoice(String(vendorUserId)),
      (err) => err.code === 'VENDOR_DEFAULT_BANK_MISSING' && err.status === 400,
    );
  });

  it('assertVendorReadyToCreateInvoice allows create when account and bank are ready', async () => {
    mockActiveVendorAccount();
    mockDefaultBank();
    const result = await eligibility.assertVendorReadyToCreateInvoice(String(vendorUserId));
    assert.equal(result.ok, true);
    assert.equal(result.required, true);
  });

  it('assertVendorReadyToCreateInvoice no-ops when merchant mode is off', async () => {
    payloadConfig.payload.vendorMerchantEnabled = false;
    const result = await eligibility.assertVendorReadyToCreateInvoice(String(vendorUserId));
    assert.equal(result.required, false);
    assert.equal(result.ok, true);
  });
});
