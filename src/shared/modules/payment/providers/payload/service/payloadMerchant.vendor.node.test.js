'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('path');

// Load .env so PayloadClient.isConfigured() can pass in local unit tests.
try {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: path.resolve(__dirname, '../../../../../../../.env') });
} catch {
  // optional
}

/**
 * Phase 1 unit tests: Vendor Payload Processing Account ownership,
 * feature flag, duplicate onboarding prevention, and authorization.
 */

const vendorUserId = new mongoose.Types.ObjectId().toString();
const otherUserId = new mongoose.Types.ObjectId().toString();

describe('payloadMerchant vendor Phase 1', () => {
  let payloadConfig;
  let merchantService;
  let originalVendorFlag;
  let originalEnabled;

  beforeEach(() => {
    // Fresh require each test so we can toggle config
    delete require.cache[require.resolve('../../../../../../config/payload.config')];
    delete require.cache[require.resolve('./payloadMerchant.service')];
    payloadConfig = require('../../../../../../config/payload.config');
    originalVendorFlag = payloadConfig.payload.vendorMerchantEnabled;
    originalEnabled = payloadConfig.payload.enabled;
    merchantService = require('./payloadMerchant.service');
  });

  afterEach(() => {
    payloadConfig.payload.vendorMerchantEnabled = originalVendorFlag;
    payloadConfig.payload.enabled = originalEnabled;
  });

  it('buildExternalId is stable per Vendor user (one PA mapping)', () => {
    const a = merchantService.buildExternalId({
      entityType: 'vendor',
      entityId: vendorUserId,
      createdBy: vendorUserId,
    });
    const b = merchantService.buildExternalId({
      entityType: 'vendor',
      entityId: new mongoose.Types.ObjectId().toString(),
      createdBy: vendorUserId,
    });
    assert.equal(a, `payload_vendor_${vendorUserId}`);
    assert.equal(a, b);
  });

  it('resolvePayloadOwnership maps Vendor entityId to auth user id', () => {
    const ownership = merchantService.resolvePayloadOwnership({
      entityType: 'vendor',
      clientEntityId: otherUserId,
      userId: vendorUserId,
      businessId: null,
    });
    assert.equal(String(ownership.entityId), vendorUserId);
    assert.equal(String(ownership.businessId), vendorUserId);
    assert.equal(ownership.metadata.vendorUserId, vendorUserId);
  });

  it('assertVendorMerchantFeatureEnabled rejects when flag off', () => {
    payloadConfig.payload.vendorMerchantEnabled = false;
    assert.throws(
      () => merchantService.assertVendorMerchantFeatureEnabled(),
      (err) => err.statusCode === 403 && err.code === 'VENDOR_MERCHANT_DISABLED',
    );
  });

  it('assertVendorMerchantActor allows Vendor and denies landlord', () => {
    merchantService.assertVendorMerchantActor({ userRoleName: 'Vendor' });
    merchantService.assertVendorMerchantActor({ user: { role: 'vendor' } });
    assert.throws(
      () => merchantService.assertVendorMerchantActor({ userRoleName: 'Landlord' }),
      (err) => err.statusCode === 403,
    );
    assert.throws(
      () => merchantService.assertVendorMerchantActor({ user: { role: 'hoa_board' } }),
      (err) => err.statusCode === 403,
    );
  });

  it('assertPayloadMerchantAccess allows owner Vendor and denies other Vendor', () => {
    const account = {
      entityType: 'vendor',
      createdBy: vendorUserId,
      entityId: vendorUserId,
      isDeleted: false,
    };
    merchantService.assertPayloadMerchantAccess(account, { userId: vendorUserId });
    assert.throws(
      () => merchantService.assertPayloadMerchantAccess(account, { userId: otherUserId }),
      (err) => err.statusCode === 403,
    );
  });

  it('initializeMerchantOnboarding returns existing Vendor account (duplicate prevention)', async () => {
    payloadConfig.payload.vendorMerchantEnabled = true;
    payloadConfig.payload.enabled = true;
    // Satisfy ensurePayloadEnabled without requiring live Payload credentials in unit tests.
    payloadConfig.payload.apiKey = payloadConfig.payload.apiKey || 'test_secret_key_unit';

    const existingId = new mongoose.Types.ObjectId();
    const existingDoc = {
      _id: existingId,
      entityType: 'vendor',
      createdBy: new mongoose.Types.ObjectId(vendorUserId),
      entityId: new mongoose.Types.ObjectId(vendorUserId),
      // No merchantId → syncPayloadAccountFromRemote short-circuits (no network).
      merchantId: '',
      accountName: 'Existing Vendor Co',
      merchantName: 'Existing Vendor Co',
      onboardingStatus: 'ONBOARDING',
      merchantStatus: 'PENDING',
      applicationStatus: 'PENDING',
      metadata: { awaitingPayloadProcessingAccount: true },
      isDeleted: false,
      toObject() {
        return { ...this };
      },
    };

    const PayloadAccount = require('../model/payloadAccount.model');
    const originalFindOne = PayloadAccount.findOne;
    PayloadAccount.findOne = async () => existingDoc;

    try {
      const result = await merchantService.initializeMerchantOnboarding({
        entityType: 'vendor',
        entityId: vendorUserId,
        businessId: vendorUserId,
        accountName: 'Should Not Create Second',
        createdBy: vendorUserId,
        req: { userRoleName: 'Vendor', user: { _id: vendorUserId, role: 'Vendor' } },
      });

      assert.equal(result.alreadyExists, true);
      assert.equal(result.account.id, String(existingId));
      assert.equal(result.requiresPayloadProcessingAccount, true);
    } finally {
      PayloadAccount.findOne = originalFindOne;
    }
  });

  it('initializeMerchantOnboarding rejects Vendor when feature flag is off', async () => {
    payloadConfig.payload.vendorMerchantEnabled = false;
    payloadConfig.payload.enabled = true;

    await assert.rejects(
      () => merchantService.initializeMerchantOnboarding({
        entityType: 'vendor',
        entityId: vendorUserId,
        businessId: vendorUserId,
        accountName: 'Vendor Co',
        createdBy: vendorUserId,
        req: { userRoleName: 'Vendor' },
      }),
      (err) => err.statusCode === 403 && err.code === 'VENDOR_MERCHANT_DISABLED',
    );
  });

  it('Vendor actor cannot create entityType=hoa merchant (mis-routed Settings guard)', async () => {
    payloadConfig.payload.vendorMerchantEnabled = true;
    payloadConfig.payload.enabled = true;
    payloadConfig.payload.apiKey = payloadConfig.payload.apiKey || 'test_secret_key_unit';

    await assert.rejects(
      () => merchantService.initializeMerchantOnboarding({
        entityType: 'hoa',
        entityId: new mongoose.Types.ObjectId().toString(),
        businessId: new mongoose.Types.ObjectId().toString(),
        accountName: 'Vendor-1',
        createdBy: vendorUserId,
        req: { userRoleName: 'Vendor', user: { _id: vendorUserId, role: { name: 'Vendor' } } },
      }),
      (err) => err.statusCode === 400 && err.code === 'VENDOR_MUST_USE_VENDOR_ENTITY',
    );
  });

  it('resolvePayloadOwnership + buildExternalId preserve entityType vendor vs hoa', () => {
    const hoaId = new mongoose.Types.ObjectId().toString();
    const businessId = new mongoose.Types.ObjectId().toString();

    const vendorOwnership = merchantService.resolvePayloadOwnership({
      entityType: 'vendor',
      clientEntityId: hoaId,
      userId: vendorUserId,
      businessId: null,
    });
    assert.equal(String(vendorOwnership.entityId), vendorUserId);
    assert.equal(vendorOwnership.metadata.vendorUserId, vendorUserId);
    assert.equal(vendorOwnership.metadata.hoaId, undefined);
    assert.equal(
      merchantService.buildExternalId({
        entityType: 'vendor',
        entityId: vendorOwnership.entityId,
        createdBy: vendorUserId,
        metadata: vendorOwnership.metadata,
      }),
      `payload_vendor_${vendorUserId}`,
    );

    const hoaOwnership = merchantService.resolvePayloadOwnership({
      entityType: 'hoa',
      clientEntityId: hoaId,
      userId: vendorUserId,
      businessId,
    });
    assert.equal(hoaOwnership.metadata.hoaId, hoaId);
    assert.notEqual(String(hoaOwnership.entityId), vendorUserId);
    const hoaExternalId = merchantService.buildExternalId({
      entityType: 'hoa',
      entityId: hoaOwnership.entityId,
      createdBy: vendorUserId,
      metadata: hoaOwnership.metadata,
    });
    assert.ok(hoaExternalId.startsWith('payload_hoa_'));
    assert.ok(hoaExternalId.includes(hoaId));
  });
});
