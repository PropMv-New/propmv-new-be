'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePayloadChargeCustomerId,
  classifyPayloadPaymentMethodScope,
  resolvePayloadSettlementBankIdForMerchant,
  shouldRetryPayloadChargeWithoutCustomerId,
  isInvalidPayloadChargeCustomerId,
} = require('./payloadPayinCharge.util');

describe('payloadPayinCharge HOA pay-in helpers', () => {
  it('rejects processing account id and hoa scope keys as customer ids', () => {
    assert.equal(isInvalidPayloadChargeCustomerId('acct_merch', 'acct_merch'), true);
    assert.equal(isInvalidPayloadChargeCustomerId('hoa:507f1f77bcf86cd799439011'), true);
    assert.equal(isInvalidPayloadChargeCustomerId('acct_customer', 'acct_merch'), false);
  });

  it('resolvePayloadChargeCustomerId prefers remote customer and ignores stale local processing id', () => {
    assert.equal(
      resolvePayloadChargeCustomerId({
        localCustomerId: 'acct_merch',
        remotePaymentMethod: { customer_id: 'acct_customer_real' },
        processingAccountId: 'acct_merch',
      }),
      'acct_customer_real',
    );
    assert.equal(
      resolvePayloadChargeCustomerId({
        localCustomerId: 'acct_merch',
        remotePaymentMethod: { account_id: 'acct_merch', status: 'active' },
        processingAccountId: 'acct_merch',
      }),
      '',
    );
  });

  it('classifies customer vs processing_account scoped payment methods', () => {
    assert.equal(
      classifyPayloadPaymentMethodScope({ customer_id: 'acct_cust' }),
      'customer',
    );
    assert.equal(
      classifyPayloadPaymentMethodScope({ account_id: 'acct_merch' }),
      'processing_account',
    );
  });

  it('only routes deposit bank when it belongs to the charge merchant', () => {
    assert.equal(
      resolvePayloadSettlementBankIdForMerchant(
        { depositMethodId: 'pm_dep', merchantId: 'acct_a' },
        'acct_a',
      ),
      'pm_dep',
    );
    assert.equal(
      resolvePayloadSettlementBankIdForMerchant(
        { depositMethodId: 'pm_dep', merchantId: 'acct_a' },
        'acct_b',
      ),
      '',
    );
  });

  it('retries without customer_id when Payload rejects payment_method_id', () => {
    const err = { statusCode: 400, message: 'Invalid payment_method_id for customer' };
    assert.equal(
      shouldRetryPayloadChargeWithoutCustomerId(err, { customer_id: 'acct_x', payment_method_id: 'pm_1' }),
      true,
    );
    assert.equal(
      shouldRetryPayloadChargeWithoutCustomerId(err, { payment_method_id: 'pm_1' }),
      false,
    );
  });
});
