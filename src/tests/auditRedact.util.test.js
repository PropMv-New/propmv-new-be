const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactForAudit, maskLast4 } = require('../shared/modules/audit/utils/auditRedact.util');
const { deriveAuditSource, AUDIT_SOURCES } = require('../shared/modules/audit/utils/auditSource.util');
const { buildAuditContext } = require('../shared/modules/audit/service/auditLog.service');

test('redactForAudit removes passwords and tokens', () => {
  const input = {
    email: 'user@example.com',
    password: 'secret123',
    accessToken: 'jwt-token',
    refreshToken: 'refresh-token',
    nested: { paykeyToken: 'pk_live_xxx', amount: 100 },
  };
  const out = redactForAudit(input);
  assert.equal(out.email, 'user@example.com');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.accessToken, '[REDACTED]');
  assert.equal(out.refreshToken, '[REDACTED]');
  assert.equal(out.nested.paykeyToken, '[REDACTED]');
  assert.equal(out.nested.amount, 100);
});

test('redactForAudit masks routing and account numbers', () => {
  const out = redactForAudit({
    routingNumber: '021000021',
    accountNumber: '1234567890',
    last4: '7890',
  });
  assert.equal(out.last4, '7890');
  assert.match(out.routingNumber, /\*0021$/);
  assert.match(out.accountNumber, /\*7890$/);
});

test('maskLast4 preserves last four digits', () => {
  assert.equal(maskLast4('1234567890'), '****7890');
});

test('deriveAuditSource identifies webhook paths', () => {
  assert.equal(
    deriveAuditSource({ baseUrl: '/api/v1/accounts', path: '/webhooks/account' }),
    AUDIT_SOURCES.WEBHOOK
  );
});

test('deriveAuditSource identifies admin users', () => {
  assert.equal(
    deriveAuditSource({ userId: '507f1f77bcf86cd799439011', authUser: { isAdministrator: true } }),
    AUDIT_SOURCES.ADMIN
  );
});

test('deriveAuditSource identifies authenticated users', () => {
  assert.equal(
    deriveAuditSource({ userId: '507f1f77bcf86cd799439011' }),
    AUDIT_SOURCES.USER
  );
});

test('deriveAuditSource falls back to SYSTEM', () => {
  assert.equal(deriveAuditSource({}), AUDIT_SOURCES.SYSTEM);
});

test('buildAuditContext includes source field', () => {
  const context = buildAuditContext({
    baseUrl: '/api/v1/payments',
    path: '/charges',
    headers: { 'user-agent': 'TestAgent/1.0', 'x-request-id': 'req-abc' },
    userId: '507f1f77bcf86cd799439012',
    user: { role: 'HOA Owner' },
  }, 'Payments');

  assert.equal(context.source, AUDIT_SOURCES.USER);
  assert.equal(context.requestId, 'req-abc');
  assert.match(context.browserInfo, /TestAgent/);
});
