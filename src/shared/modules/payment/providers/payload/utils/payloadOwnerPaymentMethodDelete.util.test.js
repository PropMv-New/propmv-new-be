'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOwnerPaymentMethodIdentityKey,
  normalizePaymentMethodTypeGroup,
} = require('./payloadHoaOwnerPaymentMethodList.util');

describe('payload owner payment method delete scope helpers', () => {
  it('normalizes PLAID_ACH and ACH into the same bank group', () => {
    assert.equal(normalizePaymentMethodTypeGroup('PLAID_ACH'), 'bank');
    assert.equal(normalizePaymentMethodTypeGroup('ACH'), 'bank');
    const plaid = {
      type: 'PLAID_ACH',
      display: { last4: '9999', routingNumber: '110000000' },
    };
    const ach = {
      type: 'ACH',
      display: { last4: '9999', routingNumber: '110000000' },
    };
    assert.equal(
      buildOwnerPaymentMethodIdentityKey(plaid),
      buildOwnerPaymentMethodIdentityKey(ach),
    );
  });
});
