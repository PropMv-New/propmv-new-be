/**
 * Storage integration entry point.
 *
 * Exports a singleton StorageProvider selected by STORAGE_PROVIDER
 * (or legacy MOCKS3). Call sites should continue to:
 *   const storage = require('../integrations/storage');
 *   // or legacy path (re-exported):
 *   const storage = require('../integrations/s3');
 *
 * Never import S3StorageProvider / AzureBlobStorageProvider directly from
 * business logic - use this module or StorageProviderFactory.create().
 */
const { StorageProviderFactory, resolveProviderName } = require('./StorageProviderFactory');
const StorageProvider = require('./StorageProvider');
const { StorageError } = require('./errors');

let instance;
try {
  instance = StorageProviderFactory.create();
} catch (err) {
  // Last-resort: if cloud provider misconfigured at boot, fall back to mock
  // so local/dev servers still start. Production should set credentials correctly.
  const logger = require('../../common/logger');
  let requested = 'unknown';
  try {
    requested = resolveProviderName();
  } catch (_) {
    requested = (process.env.STORAGE_PROVIDER || 'unknown').toString();
  }
  logger.error('Storage provider failed to initialize; falling back to mock', {
    provider: requested,
    module: 'storage',
    error: err && err.message,
    code: err && err.code,
  });
  const MockStorageProvider = require('./MockStorageProvider');
  instance = new MockStorageProvider();
}

module.exports = instance;
module.exports.StorageProviderFactory = StorageProviderFactory;
module.exports.StorageProvider = StorageProvider;
module.exports.StorageError = StorageError;
module.exports.resolveProviderName = resolveProviderName;
module.exports.createStorageProvider = (options) => StorageProviderFactory.create(options);
