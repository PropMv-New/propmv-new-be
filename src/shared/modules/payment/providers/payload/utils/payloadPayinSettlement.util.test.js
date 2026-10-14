'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePayloadPayinSettlementAction,
  invoiceMethodLabel,
  PAYIN_STATUS,
} = require('./payloadPayinSettlement.util');
const {
  canTransitionPayinStatus,
} = require('./payloadPayinTransition.util');

describe('invoiceMethodLabel', () => {
  it('maps card-like types to card', () => {
    assert.equal(invoiceMethodLabel('CARD'), 'card');
    assert.equal(invoiceMethodLabel('APPLE_PAY'), 'card');
    assert.equal(invoiceMethodLabel('GOOGLE_PAY'), 'card');
  });

  it('maps ACH-like types to echeck and Check21 to check21', () => {
    assert.equal(invoiceMethodLabel('ACH'), 'echeck');
    assert.equal(invoiceMethodLabel('PLAID_ACH'), 'echeck');
    assert.equal(invoiceMethodLabel('CHECK21'), 'check21');
    assert.equal(invoiceMethodLabel('CHECK'), 'check21');
  });
});

describe('resolvePayloadPayinSettlementAction (Card)', () => {
  it('settles card on PROCESSING/authorized and on immediate SUCCEEDED/processed', () => {
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CARD',
        status: PAYIN_STATUS.PROCESSING,
        eventType: 'authorized',
      }),
      'settle',
    );
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CARD',
        status: PAYIN_STATUS.SUCCEEDED,
        eventType: 'processed',
      }),
      'settle',
    );
  });

  it('does not re-settle card when alreadySettled (later processed webhook)', () => {
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CARD',
        status: PAYIN_STATUS.SUCCEEDED,
        eventType: 'processed',
        alreadySettled: true,
      }),
      'none',
    );
  });
});

describe('resolvePayloadPayinSettlementAction (ACH)', () => {
  it('does not settle ACH on PROCESSING alone', () => {
    const action = resolvePayloadPayinSettlementAction({
      methodType: 'ACH',
      status: PAYIN_STATUS.PROCESSING,
      eventType: 'payin.processing',
    });
    assert.equal(action, 'none');
  });

  it('settles ACH only on SUCCEEDED / processed (funding pending OK)', () => {
    const action = resolvePayloadPayinSettlementAction({
      methodType: 'ACH',
      status: PAYIN_STATUS.SUCCEEDED,
      eventType: 'payin.processed',
      fundingStatus: 'pending',
    });
    assert.equal(action, 'settle');
  });
});

describe('resolvePayloadPayinSettlementAction (Check21)', () => {
  it('does not settle Check21 on PROCESSING alone', () => {
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CHECK21',
        status: PAYIN_STATUS.PROCESSING,
        eventType: 'authorized',
      }),
      'none',
    );
  });

  it('holds settle when processed but funding still deferred', () => {
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CHECK21',
        status: PAYIN_STATUS.SUCCEEDED,
        eventType: 'processed',
        fundingStatus: 'pending',
      }),
      'none',
    );
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CHECK21',
        status: PAYIN_STATUS.SUCCEEDED,
        eventType: 'processed',
        fundingStatus: 'processing',
      }),
      'none',
    );
  });

  it('settles Check21 when processed and funding not deferred', () => {
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CHECK21',
        status: PAYIN_STATUS.SUCCEEDED,
        eventType: 'processed',
        fundingStatus: 'batched',
      }),
      'settle',
    );
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CHECK21',
        status: PAYIN_STATUS.SUCCEEDED,
        eventType: 'processed',
        fundingStatus: '',
      }),
      'settle',
    );
  });

  it('fails Check21 on decline/void; reverses after settle on reject', () => {
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CHECK21',
        status: PAYIN_STATUS.FAILED,
        eventType: 'decline',
      }),
      'fail',
    );
    assert.equal(
      resolvePayloadPayinSettlementAction({
        methodType: 'CHECK21',
        status: PAYIN_STATUS.FAILED,
        eventType: 'reject',
        alreadySettled: true,
      }),
      'reverse',
    );
  });
});

describe('payin status transitions', () => {
  it('allows CREATED→PROCESSING→SUCCEEDED and SUCCEEDED→RETURNED', () => {
    assert.equal(canTransitionPayinStatus('CREATED', 'PROCESSING'), true);
    assert.equal(canTransitionPayinStatus('PROCESSING', 'SUCCEEDED'), true);
    assert.equal(canTransitionPayinStatus('SUCCEEDED', 'RETURNED'), true);
  });

  it('forbids regressive SUCCEEDED→PROCESSING and FAILED→SUCCEEDED', () => {
    assert.equal(canTransitionPayinStatus('SUCCEEDED', 'PROCESSING'), false);
    assert.equal(canTransitionPayinStatus('FAILED', 'SUCCEEDED'), false);
  });
});
