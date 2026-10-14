const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  lookupRequiredPrivilegesForRoute,
  normalizePrivilegePath,
} = require('../middleware/apiPrivilegeCheck');
const { PRIVILEGE_MAPS, UNPRIVILEGED_ROUTE_ALLOWLIST } = require('../privileges');

function collectMappedKeys() {
  const keys = new Set();
  for (const map of PRIVILEGE_MAPS) {
    for (const key of Object.keys(map)) {
      keys.add(key);
    }
  }
  return keys;
}

describe('authorize privilege coverage', () => {
  it('treats empty-array map entries as found (auth-only)', () => {
    const result = lookupRequiredPrivilegesForRoute(
      'GET',
      '/api/v1/users/weather',
      PRIVILEGE_MAPS
    );
    assert.equal(result.found, true);
    assert.deepEqual(result.privileges, []);
  });

  it('returns found=false for completely unmapped routes', () => {
    const result = lookupRequiredPrivilegesForRoute(
      'GET',
      '/api/v1/does-not-exist/resource',
      PRIVILEGE_MAPS
    );
    assert.equal(result.found, false);
  });

  it('maps document delete and payment-management after portal strip', () => {
    const docDelete = lookupRequiredPrivilegesForRoute(
      'DELETE',
      '/api/v1/documents/:id',
      PRIVILEGE_MAPS
    );
    assert.equal(docDelete.found, true);
    assert.ok(docDelete.privileges.includes('DELETE_DOCUMENTS'));

    const pm = lookupRequiredPrivilegesForRoute(
      'GET',
      '/api/v1/landlord/payment-management/:propertyId',
      PRIVILEGE_MAPS
    );
    assert.equal(pm.found, true);
    assert.ok(pm.privileges.includes('VIEW_PAYMENT_MANAGEMENT'));
  });

  it('has no duplicate method+path keys across privilege maps', () => {
    const seen = new Map();
    const duplicates = [];
    for (const map of PRIVILEGE_MAPS) {
      for (const key of Object.keys(map)) {
        if (!key.includes(' ')) continue; // skip path-only fallbacks
        if (seen.has(key)) {
          duplicates.push(key);
        } else {
          seen.set(key, true);
        }
      }
    }
    assert.deepEqual(duplicates, []);
  });

  it('allow-list entries use normalized METHOD + path keys', () => {
    for (const key of UNPRIVILEGED_ROUTE_ALLOWLIST) {
      assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//);
      assert.equal(key.includes('/landlord/'), false);
      assert.equal(key.includes('/hoa/'), false);
    }
  });

  it('every route file that uses authorize has at least one privilege map loaded', () => {
    // Smoke: privilege map aggregate is non-empty and includes critical modules
    const keys = collectMappedKeys();
    assert.ok(keys.size > 50);
    assert.ok([...keys].some((k) => k.includes('/documents')));
    assert.ok([...keys].some((k) => k.includes('/email/')));
    assert.ok([...keys].some((k) => k.includes('/payment-management')));
  });

  it('normalizePrivilegePath strips portal prefixes', () => {
    assert.equal(
      normalizePrivilegePath('/api/v1/hoa/invoice/:id'),
      '/api/v1/invoice/:id'
    );
    assert.equal(
      normalizePrivilegePath('/api/v1/landlord/property/properties'),
      '/api/v1/property/properties'
    );
  });

  it('normalizePrivilegePath strips trailing slashes and query strings', () => {
    assert.equal(
      normalizePrivilegePath('/api/v1/hoa/expense/'),
      '/api/v1/expense'
    );
    assert.equal(
      normalizePrivilegePath('/api/v1/documents/hoa/?context=hoa-board'),
      '/api/v1/documents/hoa'
    );
  });

  it('matches HOA board dashboard routes used after login', () => {
    const paths = [
      ['GET', '/api/v1/users/'],
      ['GET', '/api/v1/hoa/owners/'],
      ['GET', '/api/v1/hoa/invoice/'],
      ['GET', '/api/v1/hoa/expense/'],
      ['GET', '/api/v1/documents/hoa/'],
      ['GET', '/api/v1/hoa/property/portfolio-overview'],
      ['GET', '/api/v1/hoa/property/picker'],
    ];
    for (const [method, path] of paths) {
      const result = lookupRequiredPrivilegesForRoute(method, path, PRIVILEGE_MAPS);
      assert.equal(result.found, true, `expected mapping for ${method} ${path}`);
    }
  });

  it('maps landlord tenant list-with-details after portal strip', () => {
    const result = lookupRequiredPrivilegesForRoute(
      'GET',
      '/api/v1/landlord/tenants/list-with-details',
      PRIVILEGE_MAPS
    );
    assert.equal(result.found, true);
    assert.ok(result.privileges.includes('VIEW_TENANTS'));
  });

  it('maps HOA board-members invite routes after portal strip', () => {
    const paths = [
      ['POST', '/api/v1/hoa/board-members'],
      ['GET', '/api/v1/hoa/board-members/my-hoas'],
      ['GET', '/api/v1/hoa/board-members/invite-config'],
      ['GET', '/api/v1/hoa/board-members/:hoaId/invite/validate'],
      ['POST', '/api/v1/hoa/board-members/:hoaId/invite'],
      ['GET', '/api/v1/hoa/board-members/:hoaId/members'],
      ['POST', '/api/v1/hoa/board-members/:hoaId/members/:membershipId/revoke'],
      ['POST', '/api/v1/hoa/board-members/:hoaId/members/:membershipId/restore'],
      ['DELETE', '/api/v1/hoa/board-members/:hoaId/members/:membershipId'],
      ['PATCH', '/api/v1/hoa/board-members/:hoaId/profile'],
    ];
    for (const [method, path] of paths) {
      const result = lookupRequiredPrivilegesForRoute(method, path, PRIVILEGE_MAPS);
      assert.equal(result.found, true, `expected mapping for ${method} ${path}`);
    }
  });

  it('maps HOA settings payment-reminder routes after portal strip', () => {
    const paths = [
      ['GET', '/api/v1/hoa/hoa-settings'],
      ['GET', '/api/v1/hoa/hoa-settings/:hoaId'],
      ['GET', '/api/v1/hoa/hoa-settings/:hoaId/payment-policy'],
      ['PUT', '/api/v1/hoa/hoa-settings'],
      ['PUT', '/api/v1/hoa/hoa-settings/:hoaId'],
    ];
    for (const [method, path] of paths) {
      const result = lookupRequiredPrivilegesForRoute(method, path, PRIVILEGE_MAPS);
      assert.equal(result.found, true, `expected mapping for ${method} ${path}`);
      if (method === 'GET' && path.includes('payment-policy')) {
        assert.ok(result.privileges.includes('VIEW_INCOME'));
      } else if (method === 'GET') {
        assert.ok(result.privileges.includes('VIEW_SETTINGS'));
      } else {
        assert.ok(result.privileges.includes('EDIT_SETTINGS'));
      }
    }
  });

  it('maps HOA invoice allocation-preview after portal strip', () => {
    const result = lookupRequiredPrivilegesForRoute(
      'GET',
      '/api/v1/hoa/invoice/:id/allocation-preview',
      PRIVILEGE_MAPS
    );
    assert.equal(result.found, true);
    assert.ok(result.privileges.includes('VIEW_INCOME'));
  });

  it('maps Payload owner payment method mutate routes as auth-only', () => {
    const paths = [
      ['DELETE', '/api/v1/payments/payload/payment-methods/:methodId'],
      ['PUT', '/api/v1/payments/payload/payment-methods/:methodId'],
      ['POST', '/api/v1/payments/payload/payment-methods/initialize-edit'],
    ];
    for (const [method, path] of paths) {
      const result = lookupRequiredPrivilegesForRoute(method, path, PRIVILEGE_MAPS);
      assert.equal(result.found, true, `expected mapping for ${method} ${path}`);
      assert.deepEqual(result.privileges, []);
    }
  });

  it('maps notification routes as auth-only (personal in-app alerts)', () => {
    const paths = [
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/notifications/unread-count'],
      ['PATCH', '/api/v1/notifications/:id/read'],
      ['POST', '/api/v1/notifications/mark-read'],
      ['POST', '/api/v1/notifications/mark-all-read'],
    ];
    for (const [method, path] of paths) {
      const result = lookupRequiredPrivilegesForRoute(method, path, PRIVILEGE_MAPS);
      assert.equal(result.found, true, `expected mapping for ${method} ${path}`);
      assert.deepEqual(result.privileges, []);
    }
  });

  it('src/privileges directory exists for documents', () => {
    const documentsMap = path.join(__dirname, '../privileges/documents/documents.routes.js');
    assert.equal(fs.existsSync(documentsMap), true);
  });
});
