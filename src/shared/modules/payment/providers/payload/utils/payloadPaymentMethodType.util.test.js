'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRemotePaymentMethodType,
  isInstantSettleMethodType,
} = require('./payloadPaymentMethodType.util');
const { PAYMENT_METHOD_TYPE } = require('../constants/payload.constants');

describe('resolveRemotePaymentMethodType', () => {
  it('uses explicit method_type on payment method', () => {
    assert.equal(
      resolveRemotePaymentMethodType({ method_type: 'CARD' }),
      PAYMENT_METHOD_TYPE.CARD,
    );
  });

  it('infers CARD from object type card', () => {
    assert.equal(
      resolveRemotePaymentMethodType({ type: 'card' }),
      PAYMENT_METHOD_TYPE.CARD,
    );
  });

  it('infers ACH from bank_account type', () => {
    assert.equal(
      resolveRemotePaymentMethodType({ type: 'bank_account' }),
      PAYMENT_METHOD_TYPE.ACH,
    );
  });

  it('reads nested payment_method on transaction payloads', () => {
    assert.equal(
      resolveRemotePaymentMethodType({
        payment_method: { type: 'card', method_type: 'CARD' },
      }),
      PAYMENT_METHOD_TYPE.CARD,
    );
  });

  it('infers GOOGLE_PAY from google_pay object and method_type', () => {
    assert.equal(
      resolveRemotePaymentMethodType({ method_type: 'GOOGLE_PAY' }),
      PAYMENT_METHOD_TYPE.GOOGLE_PAY,
    );
    assert.equal(
      resolveRemotePaymentMethodType({ type: 'google_pay' }),
      PAYMENT_METHOD_TYPE.GOOGLE_PAY,
    );
    assert.equal(
      resolveRemotePaymentMethodType({ google_pay: { description: 'Visa 4242' } }),
      PAYMENT_METHOD_TYPE.GOOGLE_PAY,
    );
  });
});

describe('isInstantSettleMethodType', () => {
  it('treats GOOGLE_PAY like card for settlement policy', () => {
    assert.equal(isInstantSettleMethodType(PAYMENT_METHOD_TYPE.GOOGLE_PAY), true);
  });
});
