const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveCorsOrigins,
  isOriginAllowed,
  DEFAULT_PROPMV_PORTAL_ORIGINS,
} = require('./corsOrigins');

describe('resolveCorsOrigins', () => {
  it('includes known PropMv portals in production even when env omits HOA', () => {
    const resolved = resolveCorsOrigins({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://www.propmv.com',
    });
    assert.equal(resolved.isProdLike, true);
    assert.ok(resolved.origins.includes('https://hoa.propmv.com'));
    assert.ok(resolved.origins.includes('https://www.propmv.com'));
    for (const origin of DEFAULT_PROPMV_PORTAL_ORIGINS) {
      assert.ok(resolved.origins.includes(origin), `missing ${origin}`);
    }
  });

  it('does not inject production portals in local/dev', () => {
    const resolved = resolveCorsOrigins({
      NODE_ENV: 'development',
      APP_PROFILE: 'local',
      CORS_ORIGINS: 'http://localhost:8080',
    });
    assert.equal(resolved.isProdLike, false);
    assert.deepEqual(resolved.origins, ['http://localhost:8080']);
  });

  it('allows hoa.propmv.com when production defaults apply', () => {
    const resolved = resolveCorsOrigins({
      APP_PROFILE: 'prod',
      CORS_ORIGINS: '',
    });
    assert.equal(isOriginAllowed('https://hoa.propmv.com', resolved), true);
    assert.equal(isOriginAllowed('https://evil.example.com', resolved), false);
  });
});
