/**
 * Unit tests: tenant service transaction helpers.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  withTenantTransaction,
  runInTransaction,
} = require('../portals/landlord/modules/tenants/service/tenantDb.util');

describe('withTenantTransaction', () => {
  test('reuses caller session without starting a nested transaction', async () => {
    const fakeSession = { id: 'test-session' };
    let receivedSession = null;
    const result = await withTenantTransaction(async (session) => {
      receivedSession = session;
      return 'ok';
    }, { session: fakeSession });
    assert.equal(result, 'ok');
    assert.equal(receivedSession, fakeSession);
  });

  test('runInTransaction is exported for service-layer use', () => {
    assert.equal(typeof runInTransaction, 'function');
  });
});

describe('sanitizeTenantUserForResponse', () => {
  const { sanitizeTenantUserForResponse } = require('../portals/landlord/modules/tenants/service/tenant.service');

  test('removes password from plain objects', () => {
    const out = sanitizeTenantUserForResponse({ _id: '1', email: 'a@b.com', password: 'MOCK_VALUE' });
    assert.equal(out.email, 'a@b.com');
    assert.equal(out.password, undefined);
  });
});
