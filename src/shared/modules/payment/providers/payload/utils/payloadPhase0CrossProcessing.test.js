'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Payload Phase 0 cross-processing (live optional)', () => {
  it('documents required env for live Phase 0 script', () => {
    const required = [
      'PAYLOAD_PHASE0_CUSTOMER_ID',
      'PAYLOAD_PHASE0_PAYMENT_METHOD_ID',
      'PAYLOAD_PHASE0_CHARGE_PROCESSING_ID',
    ];
    assert.equal(required.length, 3);
  });

  it('runs live charge when PAYLOAD_PHASE0_LIVE=1 and credentials are set', async (t) => {
    if (String(process.env.PAYLOAD_PHASE0_LIVE || '') !== '1') {
      t.skip('Set PAYLOAD_PHASE0_LIVE=1 to run sandbox cross-processing charge.');
      return;
    }

    const payloadConfig = require('../../../../../config/payload.config');
    if (!payloadConfig.payload.enabled || !payloadConfig.payload.apiKey) {
      t.skip('Payload is not enabled for live Phase 0.');
      return;
    }

    const customerId = String(process.env.PAYLOAD_PHASE0_CUSTOMER_ID || '').trim();
    const paymentMethodId = String(process.env.PAYLOAD_PHASE0_PAYMENT_METHOD_ID || '').trim();
    const chargeProcessingId = String(process.env.PAYLOAD_PHASE0_CHARGE_PROCESSING_ID || '').trim();
    if (!customerId || !paymentMethodId || !chargeProcessingId) {
      t.skip('Missing PAYLOAD_PHASE0_* env for live run.');
      return;
    }

    const { PayloadClient } = require('../client/payload.client');
    const client = new PayloadClient();
    const txn = await client.createPaymentTransaction({
      type: 'payment',
      amount: Number(process.env.PAYLOAD_PHASE0_AMOUNT || 1),
      description: 'PropMV Phase0 automated test',
      customer_id: customerId,
      payment_method_id: paymentMethodId,
      processing_id: chargeProcessingId,
      attrs: { propmv_phase0: 'automated_test' },
    }, {
      idempotencyKey: `phase0_test_${Date.now()}`,
    });

    assert.ok(txn?.id, 'Expected Payload transaction id from cross-processing charge');
  });
});
