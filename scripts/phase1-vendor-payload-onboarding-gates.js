'use strict';

/**
 * Phase 1 — Vendor Payload Processing Account onboarding gates.
 *
 * Verifies PropMV PayloadAccount(entityType=vendor) mapping, feature flag,
 * duplicate onboarding prevention, and authorization.
 *
 * Mongo: uses DB_URL when reachable; otherwise an in-memory PayloadAccount store
 * (PHASE1_MEMORY_DB=1 or auto-fallback) so gates still run without Atlas whitelist.
 *
 * Payload Sandbox: creates a throwaway Processing Account when API mode allows.
 *
 * Run: node scripts/phase1-vendor-payload-onboarding-gates.js
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

function installMemoryPayloadAccount(PayloadAccount) {
  const store = new Map();

  function matches(doc, query) {
    if (!doc) return false;
    if (query._id && String(doc._id) !== String(query._id)) return false;
    if (query.entityType && doc.entityType !== query.entityType) return false;
    if (query.createdBy && String(doc.createdBy) !== String(query.createdBy)) return false;
    if (query.externalId && doc.externalId !== query.externalId) return false;
    if (query.isDeleted && query.isDeleted.$ne === true && doc.isDeleted === true) return false;
    if (query.isDeleted === false && doc.isDeleted !== false) return false;
    return true;
  }

  PayloadAccount.findOne = async (query) => {
    for (const doc of store.values()) {
      if (matches(doc, query || {})) return doc;
    }
    return null;
  };

  PayloadAccount.find = (query) => {
    const rows = [...store.values()].filter((doc) => matches(doc, query || {}));
    const api = {
      sort: () => api,
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return api;
  };

  PayloadAccount.findById = async (id) => store.get(String(id)) || null;

  PayloadAccount.countDocuments = async (query) =>
    [...store.values()].filter((doc) => matches(doc, query || {})).length;

  PayloadAccount.create = async (payload) => {
    const id = new mongoose.Types.ObjectId();
    const doc = {
      ...payload,
      _id: id,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      toObject() {
        return { ...this };
      },
      save: async function save() {
        store.set(String(this._id), this);
        return this;
      },
    };
    // Unique externalId / vendor partial unique simulation
    for (const existing of store.values()) {
      if (existing.externalId === doc.externalId && !existing.isDeleted) {
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
      if (
        existing.entityType === 'vendor'
        && String(existing.createdBy) === String(doc.createdBy)
        && !existing.isDeleted
      ) {
        const err = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
    }
    store.set(String(id), doc);
    return doc;
  };

  PayloadAccount.updateOne = async (filter, update) => {
    const doc = [...store.values()].find((d) => matches(d, filter));
    if (!doc) return { matchedCount: 0 };
    if (update.$set) Object.assign(doc, update.$set);
    store.set(String(doc._id), doc);
    return { matchedCount: 1 };
  };

  PayloadAccount.deleteMany = async (query) => {
    let n = 0;
    for (const [k, doc] of store.entries()) {
      if (matches(doc, query || {})) {
        store.delete(k);
        n += 1;
      }
    }
    return { deletedCount: n };
  };

  return store;
}

async function tryConnectMongo(dbUrl) {
  const forceMemory = String(process.env.PHASE1_MEMORY_DB || '').toLowerCase() === 'true'
    || process.env.PHASE1_MEMORY_DB === '1';
  if (forceMemory) return { ok: false, reason: 'PHASE1_MEMORY_DB forced' };
  if (!dbUrl) return { ok: false, reason: 'no DB_URL' };

  try {
    await mongoose.connect(dbUrl, {
      dbName: process.env.DB_NAME || undefined,
      serverSelectionTimeoutMS: 8000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function main() {
  process.env.PAYLOAD_VENDOR_MERCHANT_ENABLED = 'true';

  delete require.cache[require.resolve('../src/config/payload.config')];
  const payloadConfig = require('../src/config/payload.config');
  payloadConfig.payload.vendorMerchantEnabled = true;
  payloadConfig.payload.enabled = true;

  const PayloadAccount = require('../src/shared/modules/payment/providers/payload/model/payloadAccount.model');
  const { PayloadClient } = require('../src/shared/modules/payment/providers/payload/client/payload.client');

  const client = new PayloadClient();
  record('CONFIG', client.isConfigured() ? 'PASS' : 'FAIL', {
    message: client.isConfigured()
      ? 'Payload client configured; vendorMerchantEnabled forced true for script'
      : 'Payload client not configured',
    data: {
      environment: payloadConfig.payload.environment,
      vendorMerchantEnabled: payloadConfig.payload.vendorMerchantEnabled,
      merchantOnboardingMode: payloadConfig.payload.merchantOnboardingMode,
    },
  });
  if (!client.isConfigured()) {
    process.exitCode = 1;
    return;
  }

  const dbUrl = process.env.DB_URL || process.env.MONGODB_URI;
  const mongo = await tryConnectMongo(dbUrl);
  let dbMode = 'atlas';
  if (!mongo.ok) {
    dbMode = 'memory';
    installMemoryPayloadAccount(PayloadAccount);
    record('CONFIG_DB', 'WARN', {
      message: `Using in-memory PayloadAccount store (${mongo.reason}). Atlas/Mongo not used.`,
    });
  } else {
    record('CONFIG_DB', 'PASS', { message: 'Connected to MongoDB' });
  }

  // Require service AFTER memory hooks so create/findOne use the patched model.
  delete require.cache[require.resolve('../src/shared/modules/payment/providers/payload/service/payloadMerchant.service')];
  const {
    initializeMerchantOnboarding,
    listMerchantAccounts,
    assertPayloadMerchantAccess,
    findExistingVendorPayloadAccount,
    buildExternalId,
  } = require('../src/shared/modules/payment/providers/payload/service/payloadMerchant.service');

  const vendorUserId = new mongoose.Types.ObjectId();
  const otherUserId = new mongoose.Types.ObjectId();
  const stamp = Date.now();
  const accountName = `PropMV Phase1 Vendor ${stamp}`;

  await PayloadAccount.deleteMany({
    entityType: 'vendor',
    createdBy: vendorUserId,
  });

  let created;
  try {
    created = await initializeMerchantOnboarding({
      entityType: 'vendor',
      entityId: String(vendorUserId),
      businessId: String(vendorUserId),
      accountName,
      createdBy: String(vendorUserId),
      req: { userRoleName: 'Vendor', user: { _id: vendorUserId, role: 'Vendor' } },
    });
  } catch (err) {
    record('A_INITIALIZE', 'FAIL', { message: err.message, data: { statusCode: err.statusCode } });
    process.exitCode = 1;
    if (dbMode === 'atlas') await mongoose.disconnect();
    return;
  }

  const account = created?.account;
  const expectedExternalId = buildExternalId({
    entityType: 'vendor',
    entityId: vendorUserId,
    createdBy: vendorUserId,
  });

  const dbDoc = await PayloadAccount.findById(account.id);
  const lean = dbDoc && typeof dbDoc.toObject === 'function' ? dbDoc.toObject() : dbDoc;
  const mappingOk = lean
    && lean.entityType === 'vendor'
    && String(lean.entityId) === String(vendorUserId)
    && String(lean.createdBy) === String(vendorUserId)
    && lean.externalId === expectedExternalId
    && lean.metadata?.vendorUserId === String(vendorUserId);

  record('A_INITIALIZE', mappingOk ? 'PASS' : 'FAIL', {
    message: mappingOk
      ? `PayloadAccount(entityType=vendor) created with correct Vendor mapping (${dbMode})`
      : 'Vendor mapping mismatch',
    data: {
      dbMode,
      accountId: account?.id,
      merchantId: account?.merchantId || null,
      onboardingStatus: account?.onboardingStatus,
      alreadyExists: created?.alreadyExists,
      externalId: lean?.externalId,
      expectedExternalId,
      onboardingMode: created?.onboardingMode,
    },
  });

  // Payload Sandbox: always create a throwaway PA to prove sandbox still accepts Vendor-like PAs.
  let sandboxPaId = null;
  try {
    const pa = await client.createProcessingAccount({
      name: `${accountName} Sandbox`,
      application_link: true,
      attrs: { propmv_phase1: 'vendor', stamp: String(stamp) },
    });
    sandboxPaId = pa?.id || null;
    record('A2_SANDBOX_PA', sandboxPaId ? 'PASS' : 'FAIL', {
      message: sandboxPaId
        ? 'Created throwaway Vendor-like Processing Account in Payload Sandbox'
        : 'Sandbox PA create returned no id',
      data: { sandboxPaId, status: pa?.status, object: pa?.object },
    });
  } catch (err) {
    record('A2_SANDBOX_PA', 'FAIL', {
      message: `Sandbox PA create failed: ${err.message}`,
      data: { statusCode: err.statusCode },
    });
  }

  const dup = await initializeMerchantOnboarding({
    entityType: 'vendor',
    entityId: String(vendorUserId),
    businessId: String(vendorUserId),
    accountName: `${accountName} DUPLICATE`,
    createdBy: String(vendorUserId),
    req: { userRoleName: 'Vendor', user: { _id: vendorUserId, role: 'Vendor' } },
  });
  const dupOk = dup?.alreadyExists === true && String(dup?.account?.id) === String(account.id);
  const countAfter = await PayloadAccount.countDocuments({
    entityType: 'vendor',
    createdBy: vendorUserId,
    isDeleted: { $ne: true },
  });
  record('B_DUPLICATE_PREVENTION', dupOk && countAfter === 1 ? 'PASS' : 'FAIL', {
    message: dupOk && countAfter === 1
      ? 'Second initialize returned existing account; still one Vendor PayloadAccount'
      : 'Duplicate onboarding not prevented',
    data: {
      alreadyExists: dup?.alreadyExists,
      countAfter,
      sameId: String(dup?.account?.id) === String(account.id),
    },
  });

  const listed = await listMerchantAccounts({
    entityType: 'vendor',
    createdBy: String(vendorUserId),
  });
  record('C_LIST_SCOPING', listed.length === 1 && listed[0].id === String(account.id) ? 'PASS' : 'FAIL', {
    message: 'listMerchantAccounts returns only this Vendor account',
    data: { count: listed.length, ids: listed.map((r) => r.id) },
  });

  let authOwnerOk = false;
  let authOtherDenied = false;
  try {
    assertPayloadMerchantAccess(lean, { userId: String(vendorUserId) });
    authOwnerOk = true;
  } catch {
    authOwnerOk = false;
  }
  try {
    assertPayloadMerchantAccess(lean, { userId: String(otherUserId) });
    authOtherDenied = false;
  } catch (err) {
    authOtherDenied = err.statusCode === 403;
  }
  record('D_AUTHORIZATION', authOwnerOk && authOtherDenied ? 'PASS' : 'FAIL', {
    message: 'Owner Vendor allowed; other Vendor denied',
    data: { authOwnerOk, authOtherDenied },
  });

  payloadConfig.payload.vendorMerchantEnabled = false;
  let flagDenied = false;
  try {
    await initializeMerchantOnboarding({
      entityType: 'vendor',
      entityId: String(otherUserId),
      businessId: String(otherUserId),
      accountName: 'Should Fail Flag',
      createdBy: String(otherUserId),
      req: { userRoleName: 'Vendor' },
    });
  } catch (err) {
    flagDenied = err.statusCode === 403 && err.code === 'VENDOR_MERCHANT_DISABLED';
  }
  payloadConfig.payload.vendorMerchantEnabled = true;
  record('E_FEATURE_FLAG', flagDenied ? 'PASS' : 'FAIL', {
    message: flagDenied
      ? 'initialize rejected when vendorMerchantEnabled=false'
      : 'Feature flag gate failed',
  });

  const found = await findExistingVendorPayloadAccount(vendorUserId);
  record('F_FIND_EXISTING', found && String(found._id) === String(account.id) ? 'PASS' : 'FAIL', {
    message: 'findExistingVendorPayloadAccount locates the Vendor PA mapping',
  });

  if (dbMode === 'atlas') {
    await PayloadAccount.updateOne(
      { _id: account.id },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          'metadata.propmvPhase1': true,
          'metadata.propmvPhase1Stamp': stamp,
          'metadata.propmvPhase1SandboxPaId': sandboxPaId,
        },
      },
    );
    record('G_CLEANUP', 'PASS', {
      message: 'Soft-deleted Phase 1 throwaway PayloadAccount',
      data: { accountId: account.id, sandboxPaId },
    });
  } else {
    record('G_CLEANUP', 'PASS', {
      message: 'Memory store discarded at process exit; sandbox PA left in Payload dashboard',
      data: { accountId: account.id, sandboxPaId },
    });
  }

  const outPath = path.join(__dirname, '../docs/phase1-vendor-payload-onboarding-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    dbMode,
    results,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);

  const failed = results.some((r) => r.status === 'FAIL');
  process.exitCode = failed ? 1 : 0;
  if (dbMode === 'atlas') await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
});
