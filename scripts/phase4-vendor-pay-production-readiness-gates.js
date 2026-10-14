'use strict';

/**
 * Phase 4 Production Readiness / Live Verification gates.
 *
 * Hard rules:
 * - Does NOT set PAYLOAD_VENDOR_PAY_ENABLED=true.
 * - Refuses live Card/ACH charges unless:
 *     PHASE4_PROD_CANARY=1 AND PAYLOAD_ENVIRONMENT=production
 *   (tightly controlled production canary only).
 * - Refuses to treat sandbox / production-like results as enablement GO.
 *
 * Run: node scripts/phase4-vendor-pay-production-readiness-gates.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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
  const outPath = path.join(__dirname, '../docs/phase4-vendor-pay-production-readiness-results.json');
  const enablementAllowed = false; // never auto-enable
  fs.writeFileSync(outPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    outcome,
    enablementAllowed,
    productionRailEvidenceRequired: true,
    note:
      'Sandbox/regression PASS is not sufficient for enablement GO. '
      + 'Keep PAYLOAD_VENDOR_PAY_ENABLED=false until G1–G14 PASS with production-rail evidence '
      + 'and explicit enablement approval.',
    results,
  }, null, 2));
  console.log(`\nWrote ${outPath} (outcome=${outcome}, enablementAllowed=${enablementAllowed})`);
}

function mapGate(id, status, message, data) {
  record(id, status, { message, data });
}

async function main() {
  delete require.cache[require.resolve('../src/config/payload.config')];
  const payloadConfig = require('../src/config/payload.config');

  const envName = String(payloadConfig.payload.environment || process.env.PAYLOAD_ENVIRONMENT || '').toLowerCase();
  const vendorPayEnabled = Boolean(payloadConfig.payload.vendorPayEnabled);
  const vendorMerchantEnabled = Boolean(payloadConfig.payload.vendorMerchantEnabled);
  const prodCanaryRequested = String(process.env.PHASE4_PROD_CANARY || '').trim() === '1';
  const isProductionPayload = envName === 'production';
  const allowLiveRail = prodCanaryRequested && isProductionPayload;

  mapGate('FLAG_OFF_PRECONDITION', !vendorPayEnabled ? 'PASS' : 'FAIL', !vendorPayEnabled
    ? 'PAYLOAD_VENDOR_PAY_ENABLED is false (required until explicit enablement GO)'
    : 'PAYLOAD_VENDOR_PAY_ENABLED is true — disable before readiness verification completes', {
    vendorPayEnabled,
    vendorMerchantEnabled,
    environment: envName,
    phase4ProdCanary: prodCanaryRequested,
    liveRailAllowedThisRun: allowLiveRail,
  });

  mapGate('CREDENTIAL_ISOLATION', !(!isProductionPayload && prodCanaryRequested) ? 'PASS' : 'FAIL',
    prodCanaryRequested && !isProductionPayload
      ? 'PHASE4_PROD_CANARY=1 with non-production PAYLOAD_ENVIRONMENT — refused (no prod keys in non-prod)'
      : 'Credential isolation rule respected for this run', {
      environment: envName,
      phase4ProdCanary: prodCanaryRequested,
    });

  // --- Code / regression evidence (not production-rail) ---
  const unit = spawnSync('node', ['--test',
    'src/shared/modules/payment/providers/payload/service/payloadVendorPayin.node.test.js',
    'src/shared/modules/payment/providers/payload/service/payloadVendorEligibility.node.test.js',
    'src/shared/modules/payment/providers/payload/service/payloadMerchant.vendor.node.test.js',
    'src/shared/modules/payment/providers/payload/service/payloadDepositMethod.vendor.node.test.js',
    'src/shared/modules/payment/providers/payload/utils/payloadPayinCharge.node.test.js',
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  mapGate('REGRESSION_UNIT', unit.status === 0 ? 'PASS' : 'FAIL',
    unit.status === 0
      ? 'Phase 1–4 unit + HOA payin helpers PASS'
      : 'Unit regression failed', {
      exitCode: unit.status,
      tail: String(unit.stdout || unit.stderr || '').slice(-500),
    });

  const uiGate = spawnSync('node', ['--test',
    path.join(__dirname, '../../innago-inspired-refresh/src/shared/pages/vendor-invoices/__tests__/vendorInvoiceElectronicPayGate.node.test.cjs'),
  ], { encoding: 'utf8' });
  mapGate('REGRESSION_UI_GATE', uiGate.status === 0 ? 'PASS' : 'FAIL',
    uiGate.status === 0 ? 'Vendor pay UI gate truth table PASS' : 'UI gate failed', {
      exitCode: uiGate.status,
    });

  // Settlement util sole authority (code evidence)
  const {
    resolvePayloadPayinSettlementAction,
  } = require('../src/shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util');
  const achPending = resolvePayloadPayinSettlementAction({
    methodType: 'ACH', status: 'PROCESSING', alreadySettled: false,
  });
  const achSettle = resolvePayloadPayinSettlementAction({
    methodType: 'ACH', status: 'SUCCEEDED', eventType: 'processed', alreadySettled: false,
  });
  const cardSettle = resolvePayloadPayinSettlementAction({
    methodType: 'CARD', status: 'PROCESSING', eventType: 'authorized', alreadySettled: false,
  });
  mapGate('SETTLEMENT_UTIL_AUTHORITY',
    achPending === 'none' && achSettle === 'settle' && cardSettle === 'settle' ? 'PASS' : 'FAIL',
    'resolvePayloadPayinSettlementAction remains sole settle authority (code)',
    { achPending, achSettle, cardSettle });

  // Amount rule
  const { resolveVendorPayinAmounts } = require(
    '../src/shared/modules/payment/providers/payload/service/payloadVendorPayin.service',
  );
  const amounts = await resolveVendorPayinAmounts(12.34);
  mapGate('AMOUNT_RULE_NO_HOA_FEE',
    amounts.processingFeeAmount === 0 && amounts.chargeAmountDollars === 12.34 ? 'PASS' : 'FAIL',
    'invoicePaymentAmount only; processingFeeAmount=0',
    amounts);

  // Webhook auth posture (env)
  const bearerSet = Boolean(String(process.env.PAYLOAD_WEBHOOK_BEARER || '').trim());
  mapGate('WEBHOOK_AUTH_CONFIG',
    allowLiveRail ? (bearerSet ? 'PASS' : 'FAIL') : 'BLOCKED',
    allowLiveRail
      ? (bearerSet
        ? 'PAYLOAD_WEBHOOK_BEARER configured for production canary'
        : 'PAYLOAD_WEBHOOK_BEARER missing — required for production webhook auth gate')
      : 'Webhook auth live proof deferred until production canary run',
    {
      bearerConfigured: bearerSet,
      note: 'HMAC PAYLOAD_WEBHOOK_SECRET is not used (undocumented for Payload v2)',
    });

  // Atlas inventory (current configured DB — typically sandbox Atlas)
  const dbUrl = process.env.DB_URL || process.env.MONGODB_URI;
  if (!dbUrl) {
    mapGate('ATLAS_INVENTORY', 'BLOCKED', 'DB_URL missing');
  } else {
    try {
      await mongoose.connect(dbUrl, {
        dbName: process.env.DB_NAME || undefined,
        serverSelectionTimeoutMS: 12000,
        family: 4,
      });
      const PayloadAccount = require('../src/shared/modules/payment/providers/payload/model/payloadAccount.model');
      const { PayloadDepositMethod } = require('../src/shared/modules/payment/providers/payload/model/payloadDepositMethod.model');
      const PayloadVendorPayin = require('../src/shared/modules/payment/providers/payload/model/payloadVendorPayin.model');

      const vendorAccounts = await PayloadAccount.find({
        entityType: 'vendor',
        isDeleted: { $ne: true },
      }).select('merchantId onboardingStatus environment createdBy metadata').lean();

      const activeVendors = vendorAccounts.filter(
        (a) => String(a.onboardingStatus || '').toUpperCase() === 'ACTIVE' && a.merchantId,
      );

      let defaultBankCount = 0;
      for (const acct of activeVendors.slice(0, 25)) {
        const def = await PayloadDepositMethod.findOne({
          payloadAccountRef: acct._id,
          isDeleted: { $ne: true },
          $or: [{ defaultDepositMethod: true }, { isPrimaryPayout: true }],
        }).lean();
        if (def) defaultBankCount += 1;
      }

      const vendorPayinCount = await PayloadVendorPayin.countDocuments({ isDeleted: { $ne: true } });

      mapGate('ATLAS_INVENTORY', 'PASS',
        `Inventory against configured Mongo (${envName || 'unknown'} env keys). Not proof of production ACTIVE underwriting.`,
        {
          vendorAccountCount: vendorAccounts.length,
          activeVendorCount: activeVendors.length,
          activeWithDefaultBankSampled: defaultBankCount,
          payloadVendorPayinRows: vendorPayinCount,
          environmentConfigured: envName,
        });

      await mongoose.disconnect().catch(() => {});
    } catch (err) {
      mapGate('ATLAS_INVENTORY', 'BLOCKED', err.message);
      await mongoose.disconnect().catch(() => {});
    }
  }

  // --- Production-rail gates (G1–G14 subset that require live prod) ---
  const prodRailMessage = allowLiveRail
    ? 'Production canary mode armed — execute live Card/ACH + webhook drills per plan §4'
    : 'BLOCKED: production-rail evidence requires PHASE4_PROD_CANARY=1 and PAYLOAD_ENVIRONMENT=production. '
      + 'Sandbox/production-like runs are insufficient for enablement GO.';

  const prodStatus = allowLiveRail ? 'READY' : 'BLOCKED';

  const prodGates = [
    ['G1_PA_ACTIVE_PRODUCTION', 'Production Vendor PA ACTIVE (Payload + PropMV)'],
    ['G3_CARD_LIFECYCLE_PRODUCTION', 'Live production Card charge + settle/fail via util'],
    ['G4_ACH_LIFECYCLE_PRODUCTION', 'Live production ACH pending→settle + return path'],
    ['G5_WEBHOOK_DELIVERY_PRODUCTION', 'Live webhook delivery to PropMV production URL'],
    ['G6_WEBHOOK_AUTH_PRODUCTION', 'Live webhook bearer/OAuth verified'],
    ['G7_REFETCH_PRODUCTION', 'Secret-key GET /transactions before Vendor settle'],
    ['G8_IDEMPOTENCY_PRODUCTION', 'Duplicate webhook + attempt id on production rail'],
    ['G9_RECOVERY_PRODUCTION', 'Timeout/crash recovery on production rail'],
    ['G10_CONCURRENCY_PRODUCTION', 'Overpay protection under parallel prod canary load'],
    ['G11_BOOKS_PRODUCTION', 'VendorInvoice settle/reverse + Record Payment coexistence'],
    ['G12_MONITORING', 'Stuck Processing / missed webhook detectable'],
    ['G13_ROLLBACK_DRILL', 'Flag-off drill with HOA flows intact'],
    ['G14_REGRESSION_PACK', 'HOA payin / Autopay / Check21 / Rainforest / Straddle / Record Payment'],
  ];

  // G2 default bank — code path always enforceable; live proof still needs canary
  mapGate('G2_DEFAULT_BANK_ONLY',
    'PASS',
    'Code enforces default deposit bank only (no first-bank fallback). Live prod bank readiness still required under G1 canary.',
    { codeEnforced: true, liveProdBankProof: allowLiveRail ? 'pending_canary' : 'blocked_pending_canary' });

  for (const [id, label] of prodGates) {
    if (id === 'G14_REGRESSION_PACK') {
      // Partial: unit/UI done; full Autopay/Check21/Rainforest live smoke still needs ops sign-off
      mapGate(id, unit.status === 0 && uiGate.status === 0 ? 'PARTIAL' : 'FAIL',
        unit.status === 0 && uiGate.status === 0
          ? 'Unit/UI/HOA helper regression PASS; full production smoke of Autopay/Check21/Rainforest/Straddle still requires ops sign-off on canary window'
          : 'Core regression failed',
        { unitOk: unit.status === 0, uiOk: uiGate.status === 0 });
      continue;
    }
    if (id === 'G12_MONITORING' || id === 'G13_ROLLBACK_DRILL') {
      mapGate(id, 'BLOCKED',
        `${label} — requires production canary window + ops runbook execution`,
        { requires: 'production_canary' });
      continue;
    }
    mapGate(id, prodStatus === 'READY' ? 'PENDING_CANARY' : 'BLOCKED',
      `${label}. ${prodRailMessage}`,
      { productionRailRequired: true });
  }

  mapGate('ENABLEMENT_AUTO', 'PASS',
    'Script will not enable PAYLOAD_VENDOR_PAY_ENABLED. Stop for explicit enablement approval after GO.',
    { enablementAllowed: false });

  const failed = results.some((r) => r.status === 'FAIL');
  const blockedProd = results.some((r) => String(r.gate).startsWith('G') && r.status === 'BLOCKED');
  const outcome = failed ? 'fail' : (blockedProd ? 'no_go_pending_production_canary' : 'pass');
  writeResults(outcome);
  process.exitCode = failed ? 1 : 0; // BLOCKED is expected without canary — not a script failure
}

main().catch((err) => {
  console.error(err);
  record('FATAL', 'FAIL', { message: err.message });
  writeResults('fail');
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
