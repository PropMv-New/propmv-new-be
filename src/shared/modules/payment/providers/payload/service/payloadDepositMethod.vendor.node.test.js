'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../../../../../.env') });
} catch {
  // optional
}

describe('payloadDepositMethod vendor Phase 2', () => {
  let payloadConfig;
  let depositService;
  let originalVendorFlag;
  let originalEnabled;

  beforeEach(() => {
    delete require.cache[require.resolve('../../../../../../config/payload.config')];
    delete require.cache[require.resolve('./payloadMerchant.service')];
    delete require.cache[require.resolve('./payloadDepositMethod.service')];
    payloadConfig = require('../../../../../../config/payload.config');
    originalVendorFlag = payloadConfig.payload.vendorMerchantEnabled;
    originalEnabled = payloadConfig.payload.enabled;
    depositService = require('./payloadDepositMethod.service');
  });

  afterEach(() => {
    payloadConfig.payload.vendorMerchantEnabled = originalVendorFlag;
    payloadConfig.payload.enabled = originalEnabled;
  });

  it('extractVerificationStatus and extractTransferType read Payload fields', () => {
    assert.equal(
      depositService.extractVerificationStatus({ verification_status: 'verified' }),
      'verified',
    );
    assert.equal(
      depositService.extractTransferType({ transfer_type: 'receive-only' }),
      'receive-only',
    );
    assert.equal(
      depositService.extractTransferType({ bank_account: { transfer_type: 'receive-only' } }),
      'receive-only',
    );
  });

  it('sanitizeDepositMethodRecord exposes verification, transfer_type, defaultDepositMethod', () => {
    const sanitized = depositService.sanitizeDepositMethodRecord({
      _id: new mongoose.Types.ObjectId(),
      payloadAccountRef: new mongoose.Types.ObjectId(),
      merchantId: 'acct_vendor',
      depositMethodId: 'pm_test_1',
      isPrimaryPayout: true,
      defaultDepositMethod: true,
      status: 'ACTIVE',
      verificationStatus: 'verified',
      transferType: 'receive-only',
      methodType: 'ACH',
      last4: '6789',
    });
    assert.equal(sanitized.defaultDepositMethod, true);
    assert.equal(sanitized.isPrimaryPayout, true);
    assert.equal(sanitized.verificationStatus, 'verified');
    assert.equal(sanitized.transferType, 'receive-only');
    assert.equal(sanitized.depositMethodId, 'pm_test_1');
  });

  it('assertRemotePaymentMethodBelongsToAccount rejects foreign processing account', () => {
    const account = { merchantId: 'acct_vendor_a' };
    assert.throws(
      () => depositService.assertRemotePaymentMethodBelongsToAccount({
        account,
        remote: { id: 'pm_x', account_id: 'acct_vendor_b', type: 'bank_account' },
      }),
      (err) => err.statusCode === 403 && err.code === 'DEPOSIT_METHOD_WRONG_ACCOUNT',
    );
    // Matching account ok
    depositService.assertRemotePaymentMethodBelongsToAccount({
      account,
      remote: { id: 'pm_x', account_id: 'acct_vendor_a', type: 'bank_account' },
    });
  });

  it('assertDepositMethodNotOwnedByOtherAccount rejects cross-account pm_', async () => {
    const { PayloadDepositMethod } = require('../model/payloadDepositMethod.model');
    const accountA = { _id: new mongoose.Types.ObjectId() };
    const accountB = { _id: new mongoose.Types.ObjectId() };
    const foreignId = 'pm_owned_by_other';

    const originalFindOne = PayloadDepositMethod.findOne;
    PayloadDepositMethod.findOne = () => ({
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        payloadAccountRef: accountB._id,
        depositMethodId: foreignId,
      }),
    });

    try {
      await assert.rejects(
        () => depositService.assertDepositMethodNotOwnedByOtherAccount({
          account: accountA,
          depositMethodId: foreignId,
        }),
        (err) => err.statusCode === 409 && err.code === 'DEPOSIT_METHOD_CROSS_ACCOUNT',
      );
    } finally {
      PayloadDepositMethod.findOne = originalFindOne;
    }
  });

  it('reconcilePrimaryFlags does not wipe defaults when deposit_routes.PAYMENTS is absent', async () => {
    const { PayloadDepositMethod } = require('../model/payloadDepositMethod.model');
    const accountRef = new mongoose.Types.ObjectId();
    const calls = [];
    const originalUpdateMany = PayloadDepositMethod.updateMany;
    PayloadDepositMethod.updateMany = async (filter, update) => {
      calls.push({ filter, update });
      return { acknowledged: true, modifiedCount: 0 };
    };

    try {
      await depositService.reconcilePrimaryFlags(accountRef, {});
      assert.equal(calls.length, 0, 'must not clear flags without a PAYMENTS route id');

      await depositService.reconcilePrimaryFlags(accountRef, {
        PAYMENTS: { deposit_method_id: 'pm_default_1' },
      });
      assert.ok(calls.length >= 2);
      assert.equal(calls[0].update.$set.defaultDepositMethod, false);
      assert.equal(calls[1].filter.depositMethodId, 'pm_default_1');
      assert.equal(calls[1].update.$set.defaultDepositMethod, true);

      calls.length = 0;
      await depositService.reconcilePrimaryFlags(accountRef, {}, {
        preferredDepositMethodId: 'pm_preferred',
      });
      assert.ok(calls.length >= 2);
      assert.equal(calls[1].filter.depositMethodId, 'pm_preferred');
    } finally {
      PayloadDepositMethod.updateMany = originalUpdateMany;
    }
  });

  it('loadAccountWithAccess rejects Vendor deposit ops when flag is off', async () => {
    payloadConfig.payload.vendorMerchantEnabled = false;
    payloadConfig.payload.enabled = true;
    payloadConfig.payload.apiKey = payloadConfig.payload.apiKey || 'test_secret_key_unit';

    const merchantService = require('./payloadMerchant.service');
    const vendorAccount = {
      _id: new mongoose.Types.ObjectId(),
      entityType: 'vendor',
      merchantId: 'acct_vendor',
      createdBy: new mongoose.Types.ObjectId(),
      entityId: new mongoose.Types.ObjectId(),
      isDeleted: false,
    };

    const originalFind = merchantService.findAccountById;
    // findAccountById is used internally; stub via PayloadAccount model instead
    const PayloadAccount = require('../model/payloadAccount.model');
    const originalFindOne = PayloadAccount.findOne;
    PayloadAccount.findOne = async () => vendorAccount;

    try {
      await assert.rejects(
        () => depositService.loadAccountWithAccess({
          accountId: String(vendorAccount._id),
          userId: String(vendorAccount.createdBy),
        }),
        (err) => err.statusCode === 403 && err.code === 'VENDOR_MERCHANT_DISABLED',
      );
    } finally {
      PayloadAccount.findOne = originalFindOne;
      void originalFind;
    }
  });
});
