const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildAuditSearchQuery, buildCompanyScopeFilter } = require('../shared/modules/audit/service/auditInvestigation.service');
const { formatAuditLogForInvestigation } = require('../shared/modules/audit/utils/auditInvestigationResponse.util');
const { snapshotPaymentCard } = require('../shared/modules/audit/loaders/auditBeforeLoaders');
const { buildAuditIdempotencyKey } = require('../shared/modules/audit/utils/auditIdempotency.util');
const { shouldUseAuditOutbox } = require('../shared/modules/audit/service/auditLog.service');
const { computeAuditRetryDelayMs } = require('../shared/modules/audit/service/auditOutbox.service');
const requireAdministrator = require('../middleware/requireAdministrator');

describe('requireAdministrator middleware', () => {
  test('allows company administrators', () => {
    let called = false;
    const req = { user: { isAdministrator: true } };
    const res = { status() { return this; }, json() {} };
    requireAdministrator(req, res, () => { called = true; });
    assert.equal(called, true);
  });

  test('blocks non-administrator users', () => {
    let statusCode = null;
    const req = { user: { isAdministrator: false } };
    const res = {
      status(code) { statusCode = code; return this; },
      json() {},
    };
    requireAdministrator(req, res, () => {});
    assert.equal(statusCode, 403);
  });
});

describe('audit investigation query builder', () => {
  test('builds indexed filters for investigation search', () => {
    const query = buildAuditSearchQuery({
      module: 'Payments',
      event: 'PaymentChargeCreated',
      requestId: 'req-123',
      correlationId: 'corr-456',
      auditEventId: 'evt-uuid',
      success: true,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
    });
    assert.equal(query.module, 'Payments');
    assert.equal(query.requestId, 'req-123');
    assert.equal(query.correlationId, 'corr-456');
    assert.equal(query.auditEventId, 'evt-uuid');
    assert.equal(query.success, true);
    assert.ok(query.createdAt.$gte);
    assert.ok(query.createdAt.$lte);
  });
});

describe('audit investigation response redaction', () => {
  test('redacts sensitive fields from audit detail payloads', () => {
    const formatted = formatAuditLogForInvestigation({
      _id: '507f1f77bcf86cd799439011',
      auditEventId: 'evt-1',
      module: 'Auth',
      event: 'PasswordChanged',
      before: { password: 'secret' },
      after: { accessToken: 'jwt-token', email: 'user@example.com' },
      requestId: 'req-1',
      correlationId: 'corr-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(formatted.before.password, '[REDACTED]');
    assert.equal(formatted.after.accessToken, '[REDACTED]');
    assert.equal(formatted.after.email, 'user@example.com');
    assert.equal(formatted.requestId, 'req-1');
    assert.equal(formatted.correlationId, 'corr-1');
  });
});

describe('stripe card delete before-state snapshot', () => {
  test('captures masked card metadata only', () => {
    const snap = snapshotPaymentCard({
      id: 'pm_123',
      card: {
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: 2028,
        funding: 'credit',
        fingerprint: 'fp_abc',
      },
    }, 'pm_123');
    assert.equal(snap.paymentMethodId, 'pm_123');
    assert.equal(snap.last4, '4242');
    assert.equal(snap.isDefault, true);
    assert.equal(snap.brand, 'visa');
  });
});

describe('outbox replay idempotency keys', () => {
  test('webhook retries share one idempotency key', () => {
    const key = buildAuditIdempotencyKey({
      module: 'StraddleAccount',
      event: 'WEBHOOK_RECEIVED',
      source: 'WEBHOOK',
      after: { eventId: 'wh-replay-1' },
    });
    assert.match(key, /wh-replay-1/);
  });
});

describe('meta audit events skip outbox', () => {
  test('replay audit records bypass outbox queue', () => {
    assert.equal(
      shouldUseAuditOutbox({ module: 'AuditOperations', event: 'AuditOutboxReplayed' }, { skipOutbox: true }),
      false
    );
  });
});

describe('retry scheduling', () => {
  test('uses exponential backoff for outbox retries', () => {
    assert.equal(computeAuditRetryDelayMs(1), 5000);
    assert.equal(computeAuditRetryDelayMs(3), 20000);
  });
});

describe('company scope helper', () => {
  test('buildCompanyScopeFilter returns null without companyId', async () => {
    const scope = await buildCompanyScopeFilter({ user: {} });
    assert.equal(scope, null);
  });
});
