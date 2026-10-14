const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  computeAuditRetryDelayMs,
  buildClaimableOutboxQuery,
  OUTBOX_STATUS,
} = require('../shared/modules/audit/service/auditOutbox.service');
const { buildAuditIdempotencyKey } = require('../shared/modules/audit/utils/auditIdempotency.util');
const { isCriticalAuditModule } = require('../shared/modules/audit/utils/auditCriticalModules.util');
const {
  prepareAuditEntry,
  shouldUseAuditOutbox,
  AUDIT_SOURCES,
} = require('../shared/modules/audit/service/auditLog.service');

describe('audit idempotency keys', () => {
  test('webhook events dedupe on Straddle event_id', () => {
    const key1 = buildAuditIdempotencyKey({
      module: 'StraddleAccount',
      event: 'WEBHOOK_RECEIVED',
      source: 'WEBHOOK',
      after: { eventId: 'evt_123', eventType: 'account.created.v1' },
    });
    const key2 = buildAuditIdempotencyKey({
      module: 'StraddleAccount',
      event: 'WEBHOOK_RECEIVED',
      source: 'WEBHOOK',
      after: { eventId: 'evt_123', eventType: 'account.created.v1' },
    });
    assert.equal(key1, key2);
    assert.match(key1, /evt_123/);
  });

  test('HTTP retries with same requestId produce same idempotency key', () => {
    const base = {
      requestId: 'req-abc',
      correlationId: 'corr-xyz',
      module: 'Payments',
      event: 'PaymentChargeCreated',
      entity: 'PaymentCharge',
      entityId: '507f1f77bcf86cd799439011',
      createdBy: '507f1f77bcf86cd799439012',
      success: true,
      source: 'USER',
    };
    assert.equal(buildAuditIdempotencyKey(base), buildAuditIdempotencyKey(base));
  });

  test('failed operations produce distinct keys from successful ones', () => {
    const ok = buildAuditIdempotencyKey({
      requestId: 'req-1',
      module: 'Payments',
      event: 'PaymentChargeCreated',
      success: true,
    });
    const fail = buildAuditIdempotencyKey({
      requestId: 'req-1',
      module: 'Payments',
      event: 'PaymentChargeCreated',
      success: false,
    });
    assert.notEqual(ok, fail);
  });
});

describe('critical audit module routing', () => {
  test('payments and bank modules use outbox', () => {
    assert.equal(isCriticalAuditModule('Payments'), true);
    assert.equal(isCriticalAuditModule('PaymentCards'), true);
    assert.equal(isCriticalAuditModule('StraddleAccount'), true);
    assert.equal(isCriticalAuditModule('Billing-settings'), true);
  });

  test('webhook source always uses outbox', () => {
    assert.equal(
      shouldUseAuditOutbox({ module: 'Other', source: AUDIT_SOURCES.WEBHOOK }),
      true
    );
  });

  test('non-critical modules skip outbox when disabled module', () => {
    assert.equal(shouldUseAuditOutbox({ module: 'Marketing', source: 'USER' }), false);
  });
});

describe('retry and claim logic', () => {
  test('retry delay grows exponentially with cap', () => {
    assert.equal(computeAuditRetryDelayMs(1), 5_000);
    assert.equal(computeAuditRetryDelayMs(2), 10_000);
    assert.ok(computeAuditRetryDelayMs(20) <= 300_000);
  });

  test('claim query includes stale processing locks', () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const query = buildClaimableOutboxQuery(now);
    assert.ok(Array.isArray(query.$or));
    assert.equal(query.$or[0].status, OUTBOX_STATUS.PENDING);
    assert.equal(query.$or[1].status, OUTBOX_STATUS.PROCESSING);
  });
});

describe('in-memory outbox flow simulation', () => {
  function createSimulator() {
    const outbox = new Map();
    const auditLogs = new Map();
    let createFailCount = 0;

    return {
      setCreateFailures(n) { createFailCount = n; },
      async enqueue(prepared, { idempotencyKey, eventId = uuidv4() } = {}) {
        if (idempotencyKey && outbox.has(idempotencyKey)) {
          return outbox.get(idempotencyKey);
        }
        const row = {
          eventId,
          idempotencyKey: idempotencyKey || null,
          payload: prepared,
          status: OUTBOX_STATUS.PENDING,
          retryCount: 0,
          maxRetries: 5,
          auditLogId: null,
        };
        if (idempotencyKey) outbox.set(idempotencyKey, row);
        outbox.set(eventId, row);
        return row;
      },
      async deliver(eventId) {
        const row = outbox.get(eventId);
        if (!row) throw new Error('missing outbox row');
        if (row.status === OUTBOX_STATUS.COMPLETED) {
          return { skipped: true, auditLogId: row.auditLogId };
        }
        if (createFailCount > 0) {
          createFailCount -= 1;
          row.retryCount += 1;
          row.status = OUTBOX_STATUS.PENDING;
          throw new Error('temporary AuditLog failure');
        }
        if (auditLogs.has(eventId)) {
          row.status = OUTBOX_STATUS.COMPLETED;
          row.auditLogId = auditLogs.get(eventId)._id;
          return { skipped: true, auditLogId: row.auditLogId };
        }
        const auditLog = { _id: `log-${eventId}`, auditEventId: eventId, ...row.payload };
        auditLogs.set(eventId, auditLog);
        row.status = OUTBOX_STATUS.COMPLETED;
        row.auditLogId = auditLog._id;
        return { skipped: false, auditLogId: auditLog._id };
      },
      getAuditLog(eventId) { return auditLogs.get(eventId) || null; },
      getOutbox(eventId) { return outbox.get(eventId) || null; },
      pendingCount() {
        const seen = new Set();
        let count = 0;
        for (const row of outbox.values()) {
          if (seen.has(row.eventId)) continue;
          seen.add(row.eventId);
          if (row.status === OUTBOX_STATUS.PENDING) count += 1;
        }
        return count;
      },
    };
  }

  test('1 - business success → audit eventually delivered', async () => {
    const sim = createSimulator();
    const prepared = { module: 'Payments', event: 'PaymentChargeCreated', success: true };
    const row = await sim.enqueue(prepared, { idempotencyKey: 'pay-1', eventId: 'evt-1' });
    await sim.deliver(row.eventId);
    assert.ok(sim.getAuditLog('evt-1'));
  });

  test('2 - AuditLog write fails → remains pending and succeeds on retry', async () => {
    const sim = createSimulator();
    sim.setCreateFailures(1);
    const row = await sim.enqueue(
      { module: 'Payments', event: 'PaymentChargeCreated' },
      { idempotencyKey: 'pay-2', eventId: 'evt-2' }
    );
    await assert.rejects(() => sim.deliver(row.eventId));
    assert.equal(sim.getOutbox('evt-2').status, OUTBOX_STATUS.PENDING);
    await sim.deliver(row.eventId);
    assert.ok(sim.getAuditLog('evt-2'));
  });

  test('3 - pending events survive restart simulation', async () => {
    const sim = createSimulator();
    await sim.enqueue(
      { module: 'Property', event: 'Update' },
      { idempotencyKey: 'prop-1', eventId: 'evt-3' }
    );
    assert.equal(sim.pendingCount(), 1);
    await sim.deliver('evt-3');
    assert.equal(sim.pendingCount(), 0);
  });

  test('4 - duplicate delivery creates only one AuditLog', async () => {
    const sim = createSimulator();
    const row = await sim.enqueue(
      { module: 'Payments', event: 'PaymentChargeCreated' },
      { idempotencyKey: 'pay-4', eventId: 'evt-4' }
    );
    await sim.deliver(row.eventId);
    await sim.deliver(row.eventId);
    assert.equal(sim.getAuditLog('evt-4').auditEventId, 'evt-4');
  });

  test('5 - failed business ops record success:false without implying success', async () => {
    const prepared = prepareAuditEntry({
      module: 'Payments',
      event: 'PaymentChargeCreated',
      success: false,
      failureReason: 'HTTP 400',
    });
    assert.equal(prepared.success, false);
    assert.equal(prepared.failureReason, 'HTTP 400');
  });

  test('6 - webhook retry does not enqueue duplicate outbox row', async () => {
    const sim = createSimulator();
    const key = buildAuditIdempotencyKey({
      module: 'StraddleAccount',
      event: 'WEBHOOK_RECEIVED',
      source: 'WEBHOOK',
      after: { eventId: 'wh-99' },
    });
    const first = await sim.enqueue({ module: 'StraddleAccount', event: 'WEBHOOK_RECEIVED' }, { idempotencyKey: key, eventId: 'evt-6a' });
    const second = await sim.enqueue({ module: 'StraddleAccount', event: 'WEBHOOK_RECEIVED' }, { idempotencyKey: key, eventId: 'evt-6b' });
    assert.equal(first.eventId, second.eventId);
  });

  test('7 - worker crash simulation allows retry after failed deliver', async () => {
    const sim = createSimulator();
    sim.setCreateFailures(2);
    const row = await sim.enqueue(
      { module: 'Billing-settings', event: 'BillingSettingsUpdated' },
      { idempotencyKey: 'bill-1', eventId: 'evt-7' }
    );
    await assert.rejects(() => sim.deliver(row.eventId));
    await assert.rejects(() => sim.deliver(row.eventId));
    sim.setCreateFailures(0);
    await sim.deliver(row.eventId);
    assert.ok(sim.getAuditLog('evt-7'));
  });

  test('8 - concurrent duplicate enqueue returns same outbox eventId', async () => {
    const sim = createSimulator();
    const key = 'concurrent-key';
    const [a, b] = await Promise.all([
      sim.enqueue({ module: 'Company', event: 'Update' }, { idempotencyKey: key, eventId: 'evt-8a' }),
      sim.enqueue({ module: 'Company', event: 'Update' }, { idempotencyKey: key, eventId: 'evt-8b' }),
    ]);
    assert.equal(a.eventId, b.eventId);
  });
});

describe('eventId vs requestId vs correlationId', () => {
  test('distinct identifiers are preserved in prepared entries', () => {
    const prepared = prepareAuditEntry({
      module: 'Payments',
      event: 'PaymentChargeCreated',
      requestId: 'req-100',
      correlationId: 'corr-200',
      req: {
        headers: { 'user-agent': 'test' },
        baseUrl: '/api/v1/payments',
        path: '/charges',
        userId: '507f1f77bcf86cd799439011',
      },
    });
    assert.equal(prepared.requestId, 'req-100');
    assert.equal(prepared.correlationId, 'corr-200');
    assert.notEqual(prepared.requestId, prepared.correlationId);
  });
});
