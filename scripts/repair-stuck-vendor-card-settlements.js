'use strict';

/**
 * One-shot repair: Vendor Card payins that reached SUCCEEDED/processed without
 * settledAt (pre-fix when resolvePayloadPayinSettlementAction returned `none`).
 * Re-runs settlement util + applyVendorPayinSettlement via webhook update path.
 *
 * Usage: node -r dotenv/config scripts/repair-stuck-vendor-card-settlements.js
 * Dry-run default; pass --apply to settle.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const {
  resolvePayloadPayinSettlementAction,
  mapPayloadTransactionToPayinFields,
} = require('../src/shared/modules/payment/providers/payload/utils/payloadPayinSettlement.util');

async function main() {
  const apply = process.argv.includes('--apply');
  const rawUrl = process.env.DB_URL || process.env.MONGODB_URI;
  if (!rawUrl) {
    console.error('DB_URL / MONGODB_URI required');
    process.exit(1);
  }
  // Match app scripts: srv URIs without a path default to "test"; PropMV uses PropMv.
  const dbUrl = String(rawUrl).includes('/?')
    ? String(rawUrl).replace('/?', '/PropMv?')
    : String(rawUrl);
  await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 20000, family: 4 });

  const PayloadVendorPayin = require('../src/shared/modules/payment/providers/payload/model/payloadVendorPayin.model');
  const { applyVendorPayinWebhookUpdate } = require('../src/shared/modules/payment/providers/payload/service/payloadVendorPayin.service');

  const stuck = await PayloadVendorPayin.find({
    isDeleted: { $ne: true },
    settledAt: null,
    status: { $in: ['SUCCEEDED', 'PROCESSING'] },
    methodType: { $in: ['CARD', 'APPLE_PAY'] },
  }).lean();

  const results = [];
  for (const row of stuck) {
    const mapped = mapPayloadTransactionToPayinFields(row.raw || { status: row.status, id: row.transactionId });
    const action = resolvePayloadPayinSettlementAction({
      methodType: row.methodType,
      status: mapped.status || row.status,
      eventType: 'processed',
      hasAchReturn: mapped.hasAchReturn,
      fundingStatus: mapped.fundingStatus,
      alreadySettled: false,
    });
    const entry = {
      payinId: String(row._id),
      transactionId: row.transactionId,
      vendorInvoiceId: String(row.vendorInvoiceId),
      status: row.status,
      invoicePaymentAmount: row.invoicePaymentAmount,
      action,
    };
    if (action === 'settle' && apply && row.transactionId) {
      const updated = await applyVendorPayinWebhookUpdate({
        transactionId: row.transactionId,
        remotePayload: row.raw || { id: row.transactionId, status: 'processed' },
        eventType: 'transaction.processed',
      });
      entry.applied = Boolean(updated?.settledAt);
      entry.settledAt = updated?.settledAt || null;
    }
    results.push(entry);
  }

  console.log(JSON.stringify({ apply, count: results.length, results }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
