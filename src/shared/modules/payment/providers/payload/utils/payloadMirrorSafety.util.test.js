'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mirrorAmountExceedsExpected,
  buildMirrorChargeItems,
  pickPrimaryChargeLineItem,
  assertAutopaySettlementAmountAllowed,
} = require('./payloadMirrorSafety.util');

describe('payloadMirrorSafety.util', () => {
  it('detects mirror amount above expected charge', () => {
    assert.equal(mirrorAmountExceedsExpected(105, 100), true);
    assert.equal(mirrorAmountExceedsExpected(100.005, 100), false);
    assert.equal(mirrorAmountExceedsExpected(99, 100), false);
  });

  it('picks charge line items and preserves id on update', () => {
    const picked = pickPrimaryChargeLineItem([
      { id: 'pay_1', entry_type: 'payment', amount: 0 },
      { id: 'chg_2', entry_type: 'charge', amount: 40 },
      { id: 'chg_1', entry_type: 'charge', amount: 90 },
    ]);
    assert.equal(picked.id, 'chg_1');

    const items = buildMirrorChargeItems({
      remoteItems: [{ id: 'chg_1', entry_type: 'charge', amount: 90 }],
      chargeAmount: 75.5,
      description: 'HOA invoice 1001',
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'chg_1');
    assert.equal(items[0].amount, 75.5);
    assert.equal(items[0].entry_type, 'charge');
  });

  it('blocks autopay settlement when txn principal exceeds balance due', () => {
    const blocked = assertAutopaySettlementAmountAllowed({
      invoice: { balanceDue: 50 },
      invoicePaymentAmount: 50.02,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'txn_exceeds_balance_due');

    const ok = assertAutopaySettlementAmountAllowed({
      invoice: { balanceDue: 50 },
      invoicePaymentAmount: 50,
    });
    assert.equal(ok.allowed, true);
  });
});
