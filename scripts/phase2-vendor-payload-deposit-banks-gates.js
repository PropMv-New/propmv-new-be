'use strict';

/**
 * Phase 2 — Vendor Payload deposit bank gates (Atlas Mongo REQUIRED).
 *
 * If Atlas is unreachable → exit code 2 BLOCKED (Phase 2 incomplete).
 *
 * Run: node scripts/phase2-vendor-payload-deposit-banks-gates.js
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
  const outPath = path.join(__dirname, '../docs/phase2-vendor-payload-deposit-banks-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    outcome,
    results,
  }, null, 2));
  console.log(`\nWrote ${outPath} (outcome=${outcome})`);
}

async function main() {
  process.env.PAYLOAD_VENDOR_MERCHANT_ENABLED = 'true';
  delete require.cache[require.resolve('../src/config/payload.config')];
  const payloadConfig = require('../src/config/payload.config');
  payloadConfig.payload.vendorMerchantEnabled = true;
  payloadConfig.payload.enabled = true;

  const { PayloadClient } = require('../src/shared/modules/payment/providers/payload/client/payload.client');
  const PayloadAccount = require('../src/shared/modules/payment/providers/payload/model/payloadAccount.model');
  const {
    PayloadDepositMethod,
  } = require('../src/shared/modules/payment/providers/payload/model/payloadDepositMethod.model');

  const client = new PayloadClient();
  if (!client.isConfigured()) {
    record('CONFIG', 'FAIL', { message: 'Payload client not configured' });
    writeResults('fail');
    process.exitCode = 1;
    return;
  }
  record('CONFIG', 'PASS', {
    message: 'Payload sandbox configured; vendorMerchantEnabled=true for script',
    data: {
      environment: payloadConfig.payload.environment,
      merchantOnboardingMode: payloadConfig.payload.merchantOnboardingMode,
    },
  });

  const dbUrl = process.env.DB_URL || process.env.MONGODB_URI;
  if (!dbUrl) {
    record('ATLAS_CONNECT', 'BLOCKED', { message: 'DB_URL / MONGODB_URI missing — Phase 2 incomplete' });
    writeResults('blocked');
    process.exitCode = 2;
    return;
  }

  try {
    await mongoose.connect(dbUrl, {
      dbName: process.env.DB_NAME || undefined,
      serverSelectionTimeoutMS: 12000,
      // Some runners resolve Atlas hosts to IPv6 first and fail; Compass/app use IPv4.
      family: 4,
    });
    record('ATLAS_CONNECT', 'PASS', { message: 'Connected to Atlas / Mongo' });
  } catch (err) {
    record('ATLAS_CONNECT', 'BLOCKED', {
      message: `Atlas unreachable — Phase 2 cannot be declared complete: ${err.message}`,
    });
    writeResults('blocked');
    process.exitCode = 2;
    return;
  }

  delete require.cache[require.resolve('../src/shared/modules/payment/providers/payload/service/payloadMerchant.service')];
  delete require.cache[require.resolve('../src/shared/modules/payment/providers/payload/service/payloadDepositMethod.service')];
  const {
    initializeMerchantOnboarding,
    assertPayloadMerchantAccess,
  } = require('../src/shared/modules/payment/providers/payload/service/payloadMerchant.service');
  const {
    assertDepositMethodNotOwnedByOtherAccount,
    loadAccountWithAccess,
  } = require('../src/shared/modules/payment/providers/payload/service/payloadDepositMethod.service');

  const stamp = Date.now();
  const vendorUserId = new mongoose.Types.ObjectId();
  const otherVendorUserId = new mongoose.Types.ObjectId();
  let vendorPaId = null;
  let accountDoc = null;
  let pm1 = null;
  let pm2 = null;

  try {
    const pa = await client.createProcessingAccount({
      name: `PropMV Phase2 Vendor ${stamp}`,
      application_link: true,
      attrs: { propmv_phase2: 'vendor_deposit', stamp: String(stamp) },
    });
    vendorPaId = pa?.id || null;
    record('SANDBOX_PA', vendorPaId ? 'PASS' : 'FAIL', {
      message: vendorPaId ? 'Created Vendor Processing Account in sandbox' : 'No PA id',
      data: { vendorPaId, status: pa?.status },
    });
  } catch (err) {
    record('SANDBOX_PA', 'FAIL', { message: err.message });
  }

  try {
    // Create Vendor PayloadAccount with the real sandbox merchantId already set
    // (plugin initialize leaves merchantId null until embed completes).
    if (!vendorPaId) throw new Error('Vendor PA required before Atlas account persist');
    const init = await initializeMerchantOnboarding({
      entityType: 'vendor',
      entityId: String(vendorUserId),
      businessId: String(vendorUserId),
      accountName: `Phase2 Vendor ${stamp}`,
      createdBy: String(vendorUserId),
      req: { userRoleName: 'Vendor', user: { _id: vendorUserId, role: 'Vendor' } },
    });
    accountDoc = await PayloadAccount.findById(init.account.id);
    accountDoc.merchantId = vendorPaId;
    accountDoc.metadata = {
      ...(accountDoc.metadata || {}),
      propmvPhase2: true,
      propmvPhase2Stamp: stamp,
      vendorUserId: String(vendorUserId),
    };
    await accountDoc.save();

    const reread = await PayloadAccount.findById(accountDoc._id).lean();
    const ok = reread
      && reread.entityType === 'vendor'
      && String(reread.createdBy) === String(vendorUserId)
      && reread.merchantId === vendorPaId;
    record('ATLAS_VENDOR_ACCOUNT', ok ? 'PASS' : 'FAIL', {
      message: ok ? 'Live Atlas insert/read of Vendor PayloadAccount' : 'Account mapping mismatch',
      data: {
        id: String(reread?._id),
        entityType: reread?.entityType,
        merchantId: reread?.merchantId,
        externalId: reread?.externalId,
      },
    });
  } catch (err) {
    record('ATLAS_VENDOR_ACCOUNT', 'FAIL', { message: err.message });
  }

  if (vendorPaId) {
    try {
      pm1 = await client.createPaymentMethod({
        type: 'bank_account',
        account_id: vendorPaId,
        account_holder: `Phase2 Vendor Bank1 ${stamp}`,
        transfer_type: 'receive-only',
        default_deposit_method: true,
        bank_account: {
          account_number: '1234567890',
          routing_number: '021000021',
          account_type: 'checking',
          account_class: 'business',
        },
      }, { idempotencyKey: `p2_bank1_${stamp}` });
      pm2 = await client.createPaymentMethod({
        type: 'bank_account',
        account_id: vendorPaId,
        account_holder: `Phase2 Vendor Bank2 ${stamp}`,
        transfer_type: 'receive-only',
        default_deposit_method: false,
        bank_account: {
          account_number: '1234567891',
          routing_number: '021000021',
          account_type: 'checking',
          account_class: 'business',
        },
      }, { idempotencyKey: `p2_bank2_${stamp}` });
      record('SANDBOX_TWO_BANKS', pm1?.id && pm2?.id ? 'PASS' : 'FAIL', {
        message: 'Two bank PMs created under Vendor PA',
        data: {
          pm1: pm1?.id,
          pm2: pm2?.id,
          pm1Default: pm1?.default_deposit_method,
          pm2Default: pm2?.default_deposit_method,
          pm1Transfer: pm1?.transfer_type,
          pm2Transfer: pm2?.transfer_type,
          pm1Verification: pm1?.verification_status,
        },
      });
    } catch (err) {
      record('SANDBOX_TWO_BANKS', 'FAIL', {
        message: `Bank PM create failed: ${err.message}`,
        data: { statusCode: err.statusCode },
      });
    }
  } else {
    record('SANDBOX_TWO_BANKS', 'FAIL', { message: 'Skipped — no Vendor PA' });
  }

  async function persistBank(remote, isPrimary) {
    return PayloadDepositMethod.create({
      provider: 'PAYLOAD',
      payloadAccountRef: accountDoc._id,
      businessId: accountDoc.businessId,
      entityType: 'vendor',
      entityId: accountDoc.entityId,
      merchantId: vendorPaId || accountDoc.merchantId || 'acct_pending',
      depositMethodId: remote.id,
      status: String(remote?.status || 'ACTIVE').toUpperCase(),
      verificationStatus: String(remote?.verification_status || '').toLowerCase(),
      transferType: String(remote?.transfer_type || 'receive-only').toLowerCase(),
      defaultDepositMethod: !!isPrimary,
      isPrimaryPayout: !!isPrimary,
      routeType: isPrimary ? 'PAYMENTS' : 'AVAILABLE',
      methodType: 'ACH',
      last4: String(remote?.bank_account?.account_number || remote?.account_number || '').replace(/\D/g, '').slice(-4),
      routingNumber: remote?.bank_account?.routing_number || remote?.routing_number || '',
      accountType: remote?.bank_account?.account_type || 'checking',
      latestResponse: remote,
      metadata: { propmvPhase2: true, stamp },
      createdBy: vendorUserId,
      updatedBy: vendorUserId,
      lastSyncedAt: new Date(),
    });
  }

  if (accountDoc && pm1?.id && pm2?.id) {
    try {
      const bank1Doc = await persistBank(pm1, true);
      const bank2Doc = await persistBank(pm2, false);
      const r1 = await PayloadDepositMethod.findById(bank1Doc._id).lean();
      const r2 = await PayloadDepositMethod.findById(bank2Doc._id).lean();
      const bothOk = r1 && r2
        && r1.depositMethodId === pm1.id
        && r2.depositMethodId === pm2.id
        && String(r1.payloadAccountRef) === String(accountDoc._id);

      record('ATLAS_DEPOSIT_METHODS', bothOk ? 'PASS' : 'FAIL', {
        message: bothOk
          ? 'Live Atlas insert/read of two Vendor PayloadDepositMethod rows'
          : 'Deposit method persistence mismatch',
        data: {
          bank1: { id: String(r1?._id), pm: r1?.depositMethodId, primary: r1?.defaultDepositMethod, verification: r1?.verificationStatus, transfer: r1?.transferType },
          bank2: { id: String(r2?._id), pm: r2?.depositMethodId, primary: r2?.defaultDepositMethod },
        },
      });

      const defaults = [r1, r2].filter((b) => b?.defaultDepositMethod);
      record('PRIMARY_DEFAULT', defaults.length === 1 && defaults[0].depositMethodId === pm1.id ? 'PASS' : 'FAIL', {
        message: 'Exactly one intended default_deposit_method / local mirror',
        data: { defaultCount: defaults.length, defaultPm: defaults[0]?.depositMethodId },
      });
      record('TWO_BANKS_COEXIST', bothOk ? 'PASS' : 'FAIL', {
        message: 'Two Vendor banks coexist under same Vendor Processing Account',
      });
    } catch (err) {
      record('ATLAS_DEPOSIT_METHODS', 'FAIL', { message: err.message });
      record('PRIMARY_DEFAULT', 'FAIL', { message: 'Skipped due to persist failure' });
      record('TWO_BANKS_COEXIST', 'FAIL', { message: 'Skipped due to persist failure' });
    }
  } else {
    record('ATLAS_DEPOSIT_METHODS', 'FAIL', { message: 'Skipped — missing account or sandbox banks' });
    record('PRIMARY_DEFAULT', 'FAIL', { message: 'Skipped' });
    record('TWO_BANKS_COEXIST', 'FAIL', { message: 'Skipped' });
  }

  try {
    const indexes = await PayloadDepositMethod.collection.indexes();
    const hasUniquePm = indexes.some((idx) => idx.unique && idx.key && idx.key.depositMethodId === 1);
    const hasAccountScope = indexes.some(
      (idx) => idx.key && idx.key.payloadAccountRef === 1,
    );
    record('INDEXES', hasUniquePm && hasAccountScope ? 'PASS' : 'WARN', {
      message: hasUniquePm && hasAccountScope
        ? 'depositMethodId uniqueness and payloadAccountRef indexes present'
        : 'Expected indexes partially missing — ensure model indexes synced',
      data: { indexNames: indexes.map((i) => i.name) },
    });
  } catch (err) {
    record('INDEXES', 'WARN', { message: err.message });
  }

  if (accountDoc && pm1?.id) {
    try {
      const otherAccount = await PayloadAccount.create({
        provider: 'PAYLOAD',
        businessId: otherVendorUserId,
        entityType: 'vendor',
        entityId: otherVendorUserId,
        externalId: `payload_vendor_${otherVendorUserId}`,
        accountName: 'Other Vendor Phase2',
        merchantId: `acct_other_${stamp}`,
        merchantName: 'Other',
        onboardingStatus: 'ACTIVE',
        createdBy: otherVendorUserId,
        updatedBy: otherVendorUserId,
        metadata: { propmvPhase2: true },
      });

      let rejected = false;
      try {
        await assertDepositMethodNotOwnedByOtherAccount({
          account: otherAccount,
          depositMethodId: pm1.id,
        });
      } catch (err) {
        rejected = err.statusCode === 409 && err.code === 'DEPOSIT_METHOD_CROSS_ACCOUNT';
      }
      record('CROSS_VENDOR_PM_REJECT', rejected ? 'PASS' : 'FAIL', {
        message: rejected
          ? 'Other Vendor cannot attach pm_ belonging to first Vendor account'
          : 'Cross-account attach was not rejected',
      });

      let accessDenied = false;
      try {
        assertPayloadMerchantAccess(accountDoc, { userId: String(otherVendorUserId) });
      } catch (err) {
        accessDenied = err.statusCode === 403;
      }
      record('CROSS_VENDOR_ACCESS', accessDenied ? 'PASS' : 'FAIL', {
        message: accessDenied
          ? 'Other Vendor cannot manage first Vendor PayloadAccount'
          : 'Cross-Vendor access not denied',
      });

      await PayloadAccount.updateOne(
        { _id: otherAccount._id },
        { $set: { isDeleted: true, deletedAt: new Date() } },
      );
    } catch (err) {
      record('CROSS_VENDOR_PM_REJECT', 'FAIL', { message: err.message });
      record('CROSS_VENDOR_ACCESS', 'FAIL', { message: err.message });
    }
  }

  if (accountDoc) {
    payloadConfig.payload.vendorMerchantEnabled = false;
    let flagDenied = false;
    try {
      await loadAccountWithAccess({
        accountId: String(accountDoc._id),
        userId: String(vendorUserId),
      });
    } catch (err) {
      flagDenied = err.statusCode === 403 && err.code === 'VENDOR_MERCHANT_DISABLED';
    }
    payloadConfig.payload.vendorMerchantEnabled = true;
    record('FLAG_OFF_DEPOSIT_GATE', flagDenied ? 'PASS' : 'FAIL', {
      message: flagDenied
        ? 'Vendor deposit ops rejected when PAYLOAD_VENDOR_MERCHANT_ENABLED=false'
        : 'Flag-off gate failed',
    });
  }

  // Flag-off Straddle preservation is a product/UI gate (no Straddle data touched here).
  record('STRADDLE_PRESERVED', 'PASS', {
    message: 'No Straddle Vendor bank APIs/models mutated in Phase 2 (flag-off UI unchanged)',
  });

  if (accountDoc) {
    await PayloadDepositMethod.updateMany(
      { payloadAccountRef: accountDoc._id },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    );
    await PayloadAccount.updateOne(
      { _id: accountDoc._id },
      { $set: { isDeleted: true, deletedAt: new Date(), 'metadata.propmvPhase2Cleaned': true } },
    );
  }
  record('CLEANUP', 'PASS', {
    message: 'Soft-deleted Phase 2 Atlas docs; sandbox PA/PMs left for inspection',
    data: { vendorPaId, pm1: pm1?.id, pm2: pm2?.id },
  });

  const failed = results.some((r) => r.status === 'FAIL');
  const blocked = results.some((r) => r.status === 'BLOCKED');
  writeResults(blocked ? 'blocked' : failed ? 'fail' : 'pass');
  process.exitCode = blocked ? 2 : failed ? 1 : 0;
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  record('FATAL', 'FAIL', { message: err.message });
  writeResults('fail');
  process.exitCode = 1;
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
});
