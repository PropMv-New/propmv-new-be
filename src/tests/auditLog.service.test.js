const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAuditContext, AUDIT_SOURCES } = require('../shared/modules/audit/service/auditLog.service');

test('buildAuditContext extracts HOA portal and request metadata', () => {
  const req = {
    baseUrl: '/api/v1/hoa',
    path: '/owners/abc123',
    params: { id: 'abc123' },
    headers: {
      'user-agent': 'Mozilla/5.0',
      'x-hoa-id': '507f1f77bcf86cd799439011',
      'x-correlation-id': 'corr-123',
    },
    hoaContext: { hoaId: '507f1f77bcf86cd799439011' },
    authUser: { firstName: 'Jane', lastName: 'Board', email: 'jane@example.com', role: { name: 'HOA Board Member' } },
    userId: '507f1f77bcf86cd799439012',
  };

  const context = buildAuditContext(req, 'HOA');
  assert.equal(context.portal, 'HOA Board Member');
  assert.equal(context.userName, 'Jane Board');
  assert.equal(context.userRole, 'HOA Board Member');
  assert.equal(context.entity, 'Owner');
  assert.equal(context.entityId, 'abc123');
  assert.equal(context.correlationId, 'corr-123');
  assert.match(context.browserInfo, /Mozilla/);
});

for (const role of ['HOA Owner', 'Landlord', 'Tenant', 'Property Manager']) {
  test(`buildAuditContext uses ${role} as the portal value`, () => {
    const context = buildAuditContext({
      baseUrl: '/api/v1/resource',
      headers: {},
      user: { role },
    });

    assert.equal(context.portal, role);
    assert.equal(context.userRole, role);
  });
}

test('company role name takes precedence for portal attribution', () => {
  const context = buildAuditContext({
    baseUrl: '/api/v1/landlord',
    headers: {},
    user: { role: 'Landlord' },
    userRoleName: 'Property Manager',
  });

  assert.equal(context.portal, 'Property Manager');
  assert.equal(context.userRole, 'Property Manager');
});

test('buildAuditContext sets ADMIN source for administrators', () => {
  const context = buildAuditContext({
    baseUrl: '/api/v1/landlord',
    headers: {},
    userId: '507f1f77bcf86cd799439011',
    authUser: { isAdministrator: true, firstName: 'Admin', lastName: 'User' },
  });

  assert.equal(context.source, AUDIT_SOURCES.ADMIN);
});
