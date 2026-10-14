const config = require('../../config/default');
const logger = require('../../common/logger');
const { StorageError } = require('./errors');

const SUPPORTED = new Set(['s3', 'azure', 'mock']);

/**
 * Resolve which storage provider to use from environment / config.
 *
 * Priority:
 *   1. STORAGE_PROVIDER (s3 | azure | mock)
 *   2. Legacy MOCKS3 / MOCK_S3 / S3_USE_MOCK → mock
 *   3. Default: s3 when S3_BUCKET is set, otherwise mock (local-dev convenience)
 *
 * @returns {'s3'|'azure'|'mock'}
 */
function resolveProviderName(cfg = config) {
  const explicit = (
    process.env.STORAGE_PROVIDER ||
    (cfg.storage && cfg.storage.provider) ||
    ''
  ).toString().trim().toLowerCase();

  if (explicit) {
    if (!SUPPORTED.has(explicit)) {
      throw new StorageError(
        `Unsupported STORAGE_PROVIDER="${explicit}". Use one of: s3, azure, mock`,
        { status: 500, code: 'INVALID_PROVIDER' }
      );
    }
    return explicit;
  }

  const useMock = !!(cfg.s3 && cfg.s3.useMock);
  if (useMock) return 'mock';

  // Only auto-select S3 when bucket is explicitly configured in the environment.
  // (config.s3.bucket has a default value and must not force cloud mode by itself.)
  if ((process.env.S3_BUCKET || '').toString().trim()) {
    return 's3';
  }

  // MOCKS3=false with no STORAGE_PROVIDER and no S3_BUCKET → still prefer s3 when
  // AWS credentials are present (common production .env shape).
  if (
    (process.env.AWS_ACCESS_KEY_ID || '').toString().trim() &&
    (process.env.AWS_SECRET_ACCESS_KEY || '').toString().trim()
  ) {
    return 's3';
  }

  return 'mock';
}

/**
 * Factory: instantiate the configured storage provider.
 * Application code should never construct providers directly.
 */
class StorageProviderFactory {
  /**
   * @param {object} [options] - optional overrides for tests
   * @returns {import('./StorageProvider')}
   */
  static create(options = {}) {
    const providerName = options.provider || resolveProviderName();
    logger.info('Storage provider factory creating instance', {
      provider: providerName,
      module: 'storage',
    });

    switch (providerName) {
      case 's3': {
        const S3StorageProvider = require('./S3StorageProvider');
        return new S3StorageProvider(options);
      }
      case 'azure': {
        const AzureBlobStorageProvider = require('./AzureBlobStorageProvider');
        return new AzureBlobStorageProvider(options);
      }
      case 'mock': {
        const MockStorageProvider = require('./MockStorageProvider');
        return new MockStorageProvider(options);
      }
      default:
        throw new StorageError(`Unsupported storage provider: ${providerName}`, {
          status: 500,
          code: 'INVALID_PROVIDER',
        });
    }
  }
}

module.exports = {
  StorageProviderFactory,
  resolveProviderName,
};
