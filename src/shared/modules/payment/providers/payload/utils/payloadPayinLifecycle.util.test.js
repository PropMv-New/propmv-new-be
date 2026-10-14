'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  appendPayloadPayinLifecycleFromRemote,
  buildPayloadLifecycleStages,
  inferLifecyclePhaseFromSignals,
  LIFECYCLE_PHASE,
} = require('./payloadPayinLifecycle.util');

describe('payloadPayinLifecycle.util', () => {
  it('maps authorized webhook to verify phase', () => {
    assert.equal(
      inferLifecyclePhaseFromSignals({
        remote: { status: 'AUTHORIZED' },
        eventType: 'authorized',
        methodType: 'ACH',
      }),
      LIFECYCLE_PHASE.VERIFY,
    );
  });

  it('maps processed ACH with pending funding to deposit', () => {
    assert.equal(
      inferLifecyclePhaseFromSignals({
        remote: { status: 'PROCESSED', funding_status: 'pending' },
        eventType: 'processed',
        methodType: 'ACH',
      }),
      LIFECYCLE_PHASE.DEPOSIT,
    );
  });

  it('maps card processing to process phase', () => {
    assert.equal(
      inferLifecyclePhaseFromSignals({
        remote: { status: 'PROCESSING' },
        eventType: 'payment',
        methodType: 'CARD',
      }),
      LIFECYCLE_PHASE.PROCESS,
    );
  });

  it('builds monotonic lifecycle history across webhooks', () => {
    let history = appendPayloadPayinLifecycleFromRemote([], {
      remote: { status: 'CREATED' },
      eventType: 'payment',
      methodType: 'CARD',
      at: '2026-01-01T00:00:00.000Z',
    });
    history = appendPayloadPayinLifecycleFromRemote(history, {
      remote: { status: 'AUTHORIZED' },
      eventType: 'authorized',
      methodType: 'CARD',
      at: '2026-01-01T00:01:00.000Z',
    });
    history = appendPayloadPayinLifecycleFromRemote(history, {
      remote: { status: 'PROCESSING' },
      eventType: 'processing',
      methodType: 'CARD',
      at: '2026-01-01T00:02:00.000Z',
    });

    assert.deepEqual(
      history.map((row) => row.phase),
      ['initiate', 'verify', 'process'],
    );

    const stages = buildPayloadLifecycleStages(history, 'PROCESSING');
    const active = stages.find((stage) => stage.status === 'active');
    assert.equal(active?.phase, 'process');
  });
});
