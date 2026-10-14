'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPayloadPayinTrackerPayload } = require('./payloadPayinDisplay.util');

describe('buildPayloadPayinTrackerPayload', () => {
  it('exposes lifecycle stages for invoice tracker UI', () => {
    const tracker = buildPayloadPayinTrackerPayload({
      status: 'PROCESSING',
      methodType: 'ACH',
      payinId: 'txn_123',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      metadata: {
        payloadLifecycleHistory: [
          { phase: 'initiate', timestamp: '2026-01-01T00:00:00.000Z', details: 'Start payment' },
          { phase: 'verify', timestamp: '2026-01-01T00:01:00.000Z', details: 'Verify details' },
          { phase: 'process', timestamp: '2026-01-01T00:02:00.000Z', details: 'Process payment' },
        ],
      },
    });

    assert.equal(tracker.payin_id, 'txn_123');
    assert.ok(Array.isArray(tracker.lifecycle_stages));
    assert.equal(tracker.lifecycle_stages.length, 5);
    assert.equal(
      tracker.lifecycle_stages.find((stage) => stage.status === 'active')?.phase,
      'process',
    );
  });
});
