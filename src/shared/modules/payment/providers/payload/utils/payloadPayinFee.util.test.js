'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAuthoritativePayloadPayinAmounts,
  calculatePayloadProcessingFee,
} = require('./payloadPayinFee.util');

describe('resolveAuthoritativePayloadPayinAmounts batch fee handling', () => {
  const billingSettings = {
    transactionFees: {
      card: { feePercent: 2.9, paidBy: 'payer' },
      bankTransfer: { feeAmount: 0, paidBy: 'payer' },
    },
  };

  it('calculates a positive payer fee for card charges', () => {
    const quote = calculatePayloadProcessingFee({
      invoicePaymentAmount: 100,
      methodType: 'card',
      billingSettings,
      applyFee: true,
    });
    assert.ok(quote.processingFeeAmount > 0);
    assert.ok(quote.chargeAmount > 100);
  });

  it('autofills missing payer fee on a single-invoice charge by default', () => {
    const result = resolveAuthoritativePayloadPayinAmounts({
      invoicePaymentAmount: 100,
      chargeAmount: 100,
      methodType: 'card',
      billingSettings,
    });

    assert.equal(result.validation.valid, true);
    assert.ok(result.totalCharge > 100);
    assert.ok(result.validation.processingFeeAmount > 0);
  });

  it('does not re-add fee on multi-invoice sibling legs when skipPayerFeeAutofill is set', () => {
    const result = resolveAuthoritativePayloadPayinAmounts({
      invoicePaymentAmount: 100,
      chargeAmount: 100,
      methodType: 'card',
      billingSettings,
      skipPayerFeeAutofill: true,
    });

    assert.equal(result.validation.valid, true);
    assert.equal(result.totalCharge, 100);
    assert.equal(result.validation.processingFeeAmount, 0);
  });

  it('first leg without skip still autofills fee while sibling leg with skip does not', () => {
    const first = resolveAuthoritativePayloadPayinAmounts({
      invoicePaymentAmount: 100,
      chargeAmount: 100,
      methodType: 'card',
      billingSettings,
      skipPayerFeeAutofill: false,
    });
    const sibling = resolveAuthoritativePayloadPayinAmounts({
      invoicePaymentAmount: 50,
      chargeAmount: 50,
      methodType: 'card',
      billingSettings,
      skipPayerFeeAutofill: true,
    });

    assert.equal(first.validation.valid, true);
    assert.ok(first.totalCharge > 100);
    assert.equal(sibling.validation.valid, true);
    assert.equal(sibling.totalCharge, 50);
  });
});
