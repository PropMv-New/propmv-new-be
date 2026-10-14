const fs = require('fs');
const path = require('path');
const config = require('../../config/default');
const logger = require('../../common/logger');
const StorageProvider = require('./StorageProvider');
const { StorageError, withRetry } = require('./errors');
const { buildObjectKey, normalizeObjectKey } = require('./keyBuilder');

/**
 * Local-disk storage used for development when STORAGE_PROVIDER=mock
 * (or legacy MOCKS3=true). Preserves existing MockS3 behaviour.
 */
class MockStorageProvider extends StorageProvider {
  constructor(options = {}) {
    super();
    const s3Cfg = config.s3 || {};
    this.baseUrl = options.baseUrl || s3Cfg.baseUrl || '';
    if (!this.baseUrl) {
      logger.warn('Storage provider mock: S3_BASE_URL not set; using empty base URL');
      this.baseUrl = '';
    }

    const profile = config.profile || 'local';
    if (options.mockDir) {
      this.mockDir = options.mockDir;
    } else if (profile === 'local') {
      this.mockDir = path.join(__dirname, '../../../uploads');
    } else {
      this.mockDir = s3Cfg.mockDir || path.join(__dirname, '../../../mock_s3');
    }
    // Relative S3_MOCK_DIR (e.g. ./mock_s3) must be absolute so path-containment
    // checks compare resolve(dest) against the same root (false "Path traversal" otherwise).
    this.mockDir = path.resolve(this.mockDir);

    if (!fs.existsSync(this.mockDir)) {
      fs.mkdirSync(this.mockDir, { recursive: true });
    }

    this.uploadFolders = options.uploadFolders || s3Cfg.uploadFolders || {};
    // DocumentMetadata requires bucketName/region - keep stable mock values
    this.bucket = options.bucket || 'mock-bucket';
    this.region = options.region || 'mock-region';
    this.container = this.bucket;

    logger.info('Storage provider selected', { provider: 'mock', module: 'storage' });
  }

  get providerName() {
    return 'mock';
  }

  async upload(arg1, arg2) {
    let key;
    let destPath;

    logger.info('Storage upload started', { provider: 'mock', module: 'storage' });

    const assertWithinMockDir = (resolved) => {
      if (!resolved.startsWith(this.mockDir + path.sep) && resolved !== this.mockDir) {
        throw new StorageError('Path traversal detected', { status: 400, code: 'INVALID_KEY' });
      }
    };

    try {
      if (typeof arg1 === 'object' && arg1 !== null && arg1.key && arg1.localFilePath) {
        key = normalizeObjectKey(arg1.key);
        destPath = path.resolve(this.mockDir, key);
        assertWithinMockDir(destPath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        await fs.promises.rename(arg1.localFilePath, destPath);
      } else if (typeof arg1 === 'string' && Buffer.isBuffer(arg2)) {
        key = normalizeObjectKey(arg1);
        destPath = path.resolve(this.mockDir, key);
        assertWithinMockDir(destPath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        await fs.promises.writeFile(destPath, arg2);
      } else {
        throw new StorageError(
          'Invalid arguments to storage.upload. Expected ({ localFilePath, key }) or (key, buffer).',
          { status: 400, code: 'INVALID_UPLOAD_ARGS' }
        );
      }

      const url = `${this.baseUrl}/${key}`;
      logger.info('Storage upload completed', { provider: 'mock', module: 'storage', success: true });
      return { Location: url, Key: key };
    } catch (err) {
      if (err instanceof StorageError) {
        logger.error('Storage upload failed', { provider: 'mock', module: 'storage', error: err.message, code: err.code });
        throw err;
      }
      logger.error('Storage upload failed', { provider: 'mock', module: 'storage', error: err.message });
      throw new StorageError(err.message || 'Mock storage upload failed', {
        status: 500,
        code: 'UPLOAD_FAILED',
        cause: err,
      });
    }
  }

  getKey(documentType, filename, userId) {
    return buildObjectKey(documentType, filename, userId, this.uploadFolders);
  }

  async delete({ key }) {
    const normalized = normalizeObjectKey(key);
    const target = path.resolve(this.mockDir, normalized);
    if (!target.startsWith(this.mockDir + path.sep) && target !== this.mockDir) {
      throw new StorageError('Path traversal detected', { status: 400, code: 'INVALID_KEY' });
    }
    try {
      logger.info('Storage delete started', { provider: 'mock', module: 'storage' });
      if (fs.existsSync(target)) await fs.promises.unlink(target);
      logger.info('Storage delete completed', { provider: 'mock', module: 'storage', success: true });
      return true;
    } catch (e) {
      logger.warn('Storage delete failed', { provider: 'mock', module: 'storage', error: e.message });
      return false;
    }
  }

  async getStream({ key }) {
    const normalized = normalizeObjectKey(key);
    const filePath = path.resolve(this.mockDir, normalized.replace(/\//g, path.sep));
    if (!filePath.startsWith(this.mockDir + path.sep) && filePath !== this.mockDir) {
      throw new StorageError('Path traversal detected', { status: 400, code: 'INVALID_KEY' });
    }
    logger.info('Storage download started', { provider: 'mock', module: 'storage' });
    if (!fs.existsSync(filePath)) {
      throw new StorageError('File not found', { status: 404, code: 'OBJECT_NOT_FOUND' });
    }
    return fs.createReadStream(filePath);
  }

  async getPresignedUrl({ key, expiresIn = 3600 }) {
    const normalized = normalizeObjectKey(key);
    // Mock has no signing - return the public static URL
    void expiresIn;
    return `${this.baseUrl}/${normalized}`;
  }
}

module.exports = MockStorageProvider;
