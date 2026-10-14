const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const FACTORY_PATH = path.join(__dirname, '../integrations/storage/StorageProviderFactory');

describe('StorageProviderFactory', () => {
  it('resolveProviderName prefers STORAGE_PROVIDER', () => {
    const prev = process.env.STORAGE_PROVIDER;
    process.env.STORAGE_PROVIDER = 'azure';
    try {
      delete require.cache[require.resolve(FACTORY_PATH)];
      const { resolveProviderName } = require(FACTORY_PATH);
      assert.equal(resolveProviderName({ s3: { useMock: true, bucket: 'x' } }), 'azure');
    } finally {
      if (prev === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = prev;
      delete require.cache[require.resolve(FACTORY_PATH)];
    }
  });

  it('resolveProviderName falls back to mock when MOCKS3 via config', () => {
    const prev = process.env.STORAGE_PROVIDER;
    delete process.env.STORAGE_PROVIDER;
    try {
      delete require.cache[require.resolve(FACTORY_PATH)];
      const { resolveProviderName } = require(FACTORY_PATH);
      assert.equal(resolveProviderName({ s3: { useMock: true } }), 'mock');
    } finally {
      if (prev === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = prev;
      delete require.cache[require.resolve(FACTORY_PATH)];
    }
  });

  it('creates mock provider instance', () => {
    const { StorageProviderFactory } = require(FACTORY_PATH);
    const provider = StorageProviderFactory.create({ provider: 'mock' });
    assert.equal(provider.providerName, 'mock');
    assert.equal(typeof provider.upload, 'function');
    assert.equal(typeof provider.delete, 'function');
    assert.equal(typeof provider.getStream, 'function');
    assert.equal(typeof provider.getPresignedUrl, 'function');
    assert.equal(typeof provider.getKey, 'function');
  });

  it('sanitizes object keys via getKey', () => {
    const { StorageProviderFactory } = require(FACTORY_PATH);
    const provider = StorageProviderFactory.create({ provider: 'mock' });
    const key = provider.getKey('property', '../../../etc/passwd.jpg', 'user-1');
    assert.ok(!key.includes('..'));
    assert.ok(key.includes('user-1'));
    assert.ok(key.includes('passwd.jpg'));
  });

  it('rejects unsupported provider names', () => {
    const prev = process.env.STORAGE_PROVIDER;
    process.env.STORAGE_PROVIDER = 'gcs';
    try {
      delete require.cache[require.resolve(FACTORY_PATH)];
      const { resolveProviderName } = require(FACTORY_PATH);
      assert.throws(() => resolveProviderName({}), /Unsupported STORAGE_PROVIDER/);
    } finally {
      if (prev === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = prev;
      delete require.cache[require.resolve(FACTORY_PATH)];
    }
  });
});
