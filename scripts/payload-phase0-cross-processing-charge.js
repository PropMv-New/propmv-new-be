#!/usr/bin/env node
'use strict';

/**
 * Phase 0 — verify Payload accepts a customer-scoped payment_method on a transaction
 * whose processing_id differs from the customer's primary_processing_id.
 *
 * Usage (minimal — charge only):
 *   PAYLOAD_ENABLED=true \
 *   PAYLOAD_SECRET_KEY=... \
 *   PAYLOAD_PHASE0_CUSTOMER_ID=acct_... \
 *   PAYLOAD_PHASE0_PAYMENT_METHOD_ID=pm_... \
 *   PAYLOAD_PHASE0_PRIMARY_PROCESSING_ID=acct_A \
 *   PAYLOAD_PHASE0_CHARGE_PROCESSING_ID=acct_B \
 *   PAYLOAD_PHASE0_DEPOSIT_METHOD_ID=pm_deposit_on_B \  # optional
 *   node scripts/payload-phase0-cross-processing-charge.js
 *
 * Exit 0 when Payload returns a non-declined transaction create response.
 */

const payloadConfig = require('../src/config/payload.config');

async function main() {
  if (!payloadConfig.payload.enabled || !payloadConfig.payload.apiKey) {
    console.error(JSON.stringify({
      ok: false,
      phase: 'phase0',
      error: 'PAYLOAD_ENABLED and PAYLOAD_SECRET_KEY are required.',
    }, null, 2));
    process.exit(2);
  }

  const customerId = String(process.env.PAYLOAD_PHASE0_CUSTOMER_ID || '').trim();
  const paymentMethodId = String(process.env.PAYLOAD_PHASE0_PAYMENT_METHOD_ID || '').trim();
  const primaryProcessingId = String(process.env.PAYLOAD_PHASE0_PRIMARY_PROCESSING_ID || '').trim();
  const chargeProcessingId = String(
    process.env.PAYLOAD_PHASE0_CHARGE_PROCESSING_ID
    || process.env.PAYLOAD_PHASE0_PROCESSING_ID_B
    || '',
  ).trim();
  const depositMethodId = String(process.env.PAYLOAD_PHASE0_DEPOSIT_METHOD_ID || '').trim();
  const amount = Number(process.env.PAYLOAD_PHASE0_AMOUNT || 1);

  if (!customerId || !paymentMethodId || !chargeProcessingId) {
    console.error(JSON.stringify({
      ok: false,
      phase: 'phase0',
      error: 'Set PAYLOAD_PHASE0_CUSTOMER_ID, PAYLOAD_PHASE0_PAYMENT_METHOD_ID, and PAYLOAD_PHASE0_CHARGE_PROCESSING_ID.',
    }, null, 2));
    process.exit(2);
  }

  const { PayloadClient } = require('../src/shared/modules/payment/providers/payload/client/payload.client');
  const client = new PayloadClient();

  const report = {
    ok: false,
    phase: 'phase0',
    primaryProcessingId: primaryProcessingId || null,
    chargeProcessingId,
    crossProcessing: Boolean(
      primaryProcessingId
      && chargeProcessingId
      && primaryProcessingId !== chargeProcessingId,
    ),
    customerId,
    paymentMethodId,
    depositMethodId: depositMethodId || null,
    amount,
  };

  try {
    if (primaryProcessingId) {
      const customer = await client.getCustomer(customerId);
      report.customerPrimaryProcessingId = customer?.primary_processing_id || customer?.primaryProcessingId || null;
    }

    const body = {
      type: 'payment',
      amount,
      description: 'PropMV Phase0 cross-processing validation',
      customer_id: customerId,
      payment_method_id: paymentMethodId,
      processing_id: chargeProcessingId,
      attrs: { propmv_phase0: 'cross_processing_charge' },
    };
    if (depositMethodId) {
      body.processing_method_id = depositMethodId;
    }

    const txn = await client.createPaymentTransaction(body, {
      idempotencyKey: `phase0_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });

    report.transactionId = txn?.id || null;
    report.status = txn?.status || null;
    report.statusMessage = txn?.status_message || txn?.statusMessage || null;
    report.ok = Boolean(report.transactionId);
  } catch (err) {
    report.error = err.message || String(err);
    report.statusCode = err.statusCode || null;
    report.payload = err.payload || null;
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
