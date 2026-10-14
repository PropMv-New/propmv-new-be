'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveEventId,
  isPayinRelatedWebhookTrigger,
} = require('./payloadWebhook.service');

describe('payloadWebhook.service', () => {
  it('classifies Payload payment lifecycle triggers', () => {
    assert.equal(isPayinRelatedWebhookTrigger('authorized'), true);
    assert.equal(isPayinRelatedWebhookTrigger('processed'), true);
    assert.equal(isPayinRelatedWebhookTrigger('payment'), true);
    assert.equal(isPayinRelatedWebhookTrigger('automatic_payment'), true);
    assert.equal(isPayinRelatedWebhookTrigger('payin.updated'), true);
    assert.equal(isPayinRelatedWebhookTrigger('processing_status'), false);
  });

  it('derives stable event ids for webhook dedupe', () => {
    const payload = {
      trigger: 'authorized',
      triggered_on: { id: 'txn_abc', value: 'authorized' },
    };
    const first = deriveEventId(payload, JSON.stringify(payload));
    const second = deriveEventId(payload, JSON.stringify(payload));
    assert.equal(first, second);
    assert.match(first, /authorized:txn_abc:authorized:/);
  });
});
