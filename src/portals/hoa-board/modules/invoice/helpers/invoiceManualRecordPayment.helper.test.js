'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateManualRecordAgainstGatewayPhases,
} = require('./invoiceManualRecordPayment.helper');
const { LIFECYCLE_PHASE } = require('../../../../../shared/modules/payment/providers/payload/utils/payloadPayinLifecycle.util');

describe('invoiceManualRecordPayment.helper', () => {
  const processingGatewayTxs = [{ amount: 50 }];

  it('allows manual record during deposit phase up to collectable balance', () => {
    const result = evaluateManualRecordAgainstGatewayPhases({
      collectableBalance: 50,
      paymentAmount: 50,
      processingGatewayTxs,
      phases: [LIFECYCLE_PHASE.DEPOSIT],
    });
    assert.equal(result.ok, true);
    assert.equal(result.collectableBalance, 50);
  });

  it('blocks manual record during verify phase', () => {
    const result = evaluateManualRecordAgainstGatewayPhases({
      collectableBalance: 50,
      paymentAmount: 50,
      processingGatewayTxs,
      phases: [LIFECYCLE_PHASE.VERIFY],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'GATEWAY_PAYMENT_VERIFYING');
  });

  it('blocks amounts above collectable balance while gateway payment is in flight', () => {
    const result = evaluateManualRecordAgainstGatewayPhases({
      collectableBalance: 50,
      paymentAmount: 100,
      processingGatewayTxs,
      phases: [LIFECYCLE_PHASE.PROCESS],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PAYMENT_EXCEEDS_COLLECTABLE_BALANCE');
  });
});
