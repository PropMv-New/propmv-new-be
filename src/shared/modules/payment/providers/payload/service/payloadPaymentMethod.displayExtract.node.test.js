'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractDisplayMetadata,
} = require('./payloadPaymentMethod.service');

describe('extractDisplayMetadata Payload field mapping', () => {
  it('reads card_brand, card_number, and expiry from Payload card objects', () => {
    const meta = extractDisplayMetadata({
      type: 'card',
      card: {
        card_brand: 'visa',
        card_number: '4242424242424242',
        expiry: '12/28',
      },
    });
    assert.equal(meta.brand, 'visa');
    assert.equal(meta.last4, '4242');
    assert.equal(meta.expMonth, 12);
    assert.equal(meta.expYear, 2028);
  });

  it('reads bank_name and masked account_number for ACH', () => {
    const meta = extractDisplayMetadata({
      type: 'bank_account',
      bank_name: 'Chase',
      account_holder: 'Jane Owner',
      bank_account: {
        account_type: 'checking',
        account_number: '******1234',
        routing_number: '021000021',
      },
    });
    assert.equal(meta.bankName, 'Chase');
    assert.equal(meta.last4, '1234');
    assert.equal(meta.accountType, 'checking');
    assert.equal(meta.holderName, 'Jane Owner');
  });
});
