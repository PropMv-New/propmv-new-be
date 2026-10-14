const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../config/validateEnv');

describe('validateEnv', () => {
  it('does not throw in non-production when secrets are weak (reports insecure)', () => {
    const result = validateEnv(
      {
        NODE_ENV: 'development',
        DB_URL: 'mongodb://localhost/test',
        JWT_SECRET: 'short',
        REFRESH_TOKEN_SECRET: 'also-short',
      },
      { isProduction: false }
    );
    assert.equal(result.ok, true);
    assert.ok(result.insecure.includes('JWT_SECRET'));
  });

  it('throws in production when required env is missing', () => {
    assert.throws(
      () =>
        validateEnv(
          {
            NODE_ENV: 'production',
          },
          { isProduction: true }
        ),
      /Missing required env/
    );
  });

  it('passes with strong secrets', () => {
    const result = validateEnv(
      {
        NODE_ENV: 'production',
        DB_URL: 'mongodb://localhost/test',
        JWT_SECRET: 'a-sufficiently-long-production-secret',
        REFRESH_TOKEN_SECRET: 'another-sufficiently-long-refresh-secret',
      },
      { isProduction: true }
    );
    assert.equal(result.ok, true);
  });
});
