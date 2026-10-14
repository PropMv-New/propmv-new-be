const fs = require('fs');
const config = require('../../config/default');
const logger = require('../../common/logger');
const StorageProvider = require('./StorageProvider');
const { StorageError, withRetry } = require('./errors');
const { buildObjectKey, normalizeObjectKey } = require('./keyBuilder');

/**
 * Amazon S3 storage provider (AWS SDK v3).
 * Credentials must come from environment variables - never hardcoded.
 */
class S3StorageProvider extends StorageProvider {
  constructor(options = {}) {
    super();
    const s3Cfg = config.s3 || {};
    this.bucket = (options.bucket || process.env.S3_BUCKET || s3Cfg.bucket || '').toString().trim();
    this.region = (options.region || process.env.AWS_REGION || s3Cfg.region || 'us-east-1').toString().trim();
    this.baseUrl = this._sanitizeBaseUrl(options.baseUrl || process.env.S3_BASE_URL || s3Cfg.baseUrl || null);
    this.uploadFolders = options.uploadFolders || s3Cfg.uploadFolders || {};
    this.container = this.bucket;
    this._client = null;

    if (!this.bucket) {
      throw new StorageError('S3_BUCKET is required when STORAGE_PROVIDER=s3', {
        status: 500,
        code: 'MISSING_CREDENTIALS',
      });
    }

    const creds = this._readCredentials();
    if (!creds) {
      logger.error(
        'Storage provider s3: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set - uploads will fail until credentials are added to .env and the server is restarted',
        { provider: 's3', module: 'storage', code: 'MISSING_CREDENTIALS' }
      );
    }

    logger.info('Storage provider selected', { provider: 's3', module: 'storage' });
  }

  get providerName() {
    return 's3';
  }

  /**
   * Reject mock/localhost base URLs when using real S3 - they produce broken document links.
   */
  _sanitizeBaseUrl(raw) {
    if (!raw) return null;
    const value = String(raw).trim();
    if (!value) return null;
    if (
      value.startsWith('/') ||
      /localhost|127\.0\.0\.1|0\.0\.0\.0|\/mock-s3/i.test(value)
    ) {
      logger.warn('Ignoring non-production S3_BASE_URL for real S3 provider', {
        provider: 's3',
        module: 'storage',
      });
      return null;
    }
    return value.replace(/\/$/, '');
  }

  _readCredentials() {
    const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
    if (!accessKeyId || !secretAccessKey) return null;
    const sessionToken = (process.env.AWS_SESSION_TOKEN || '').trim();
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    };
  }

  _getClient() {
    if (this._client) return this._client;
    const credentials = this._readCredentials();
    if (!credentials) {
      throw new StorageError(
        'AWS credentials missing. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env, then restart the server.',
        { status: 500, code: 'MISSING_CREDENTIALS' }
      );
    }
    const { S3Client } = require('@aws-sdk/client-s3');
    this._client = new S3Client({
      region: this.region,
      credentials,
      followRegionRedirects: true,
    });
    return this._client;
  }

  _publicUrl(key) {
    if (this.baseUrl) {
      return `${this.baseUrl}/${key}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async upload(arg1, arg2) {
    logger.info('Storage upload started', { provider: 's3', module: 'storage' });

    let key;
    let body;
    let contentType = 'application/octet-stream';
    let removeLocal = false;
    let localPath = null;

    try {
      if (typeof arg1 === 'object' && arg1 !== null && arg1.key && arg1.localFilePath) {
        key = normalizeObjectKey(arg1.key);
        localPath = arg1.localFilePath;
        if (!fs.existsSync(localPath)) {
          throw new StorageError('Upload file not found on disk', {
            status: 400,
            code: 'INVALID_FILE',
          });
        }
        body = await fs.promises.readFile(localPath);
        contentType = arg1.contentType || 'application/octet-stream';
        removeLocal = true;
      } else if (typeof arg1 === 'string' && Buffer.isBuffer(arg2)) {
        key = normalizeObjectKey(arg1);
        body = arg2;
        contentType = 'application/octet-stream';
      } else if (
        typeof arg1 === 'object' &&
        arg1 !== null &&
        arg1.key &&
        Buffer.isBuffer(arg1.body)
      ) {
        key = normalizeObjectKey(arg1.key);
        body = arg1.body;
        contentType = arg1.contentType || 'application/octet-stream';
      } else {
        throw new StorageError(
          'Invalid arguments to storage.upload. Use upload({ localFilePath, key, contentType? }) or upload(key, buffer)',
          { status: 400, code: 'INVALID_UPLOAD_ARGS' }
        );
      }

      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await withRetry(
        () => this._getClient().send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })),
        { operation: 's3.upload' }
      );

      if (removeLocal && localPath) {
        try { await fs.promises.unlink(localPath); } catch (e) { /* ignore */ }
      }

      const location = this._publicUrl(key);
      logger.info('Storage upload completed', {
        provider: 's3',
        module: 'storage',
        success: true,
        fileSize: body.length,
      });
      return { Location: location, Key: key };
    } catch (err) {
      if (err instanceof StorageError) {
        logger.error('Storage upload failed', { provider: 's3', module: 'storage', error: err.message, code: err.code });
        throw err;
      }
      const rawStatus = err.$metadata?.httpStatusCode;
      // Never forward S3 redirect codes (3xx) as the API status - map them to 502
      const status = rawStatus && (rawStatus < 300 || rawStatus >= 400) ? rawStatus : 502;
      const code = err.name || err.Code || 'UPLOAD_FAILED';
      const message = code === 'CredentialsProviderError' || /credentials/i.test(err.message || '')
        ? 'AWS credentials missing or invalid. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env, then restart the server.'
        : rawStatus === 301
          ? 'S3 bucket region mismatch. Verify AWS_REGION matches the bucket\'s actual region.'
          : (err.message || 'S3 upload failed');
      logger.error('Storage upload failed', { provider: 's3', module: 'storage', error: message, code });
      throw new StorageError(message, {
        status: status || 502,
        code: String(code),
        cause: err,
        retryable: false,
      });
    }
  }

  getKey(documentType, filename, userId) {
    return buildObjectKey(documentType, filename, userId, this.uploadFolders);
  }

  async delete({ key }) {
    const normalized = normalizeObjectKey(key);
    try {
      logger.info('Storage delete started', { provider: 's3', module: 'storage' });
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await withRetry(
        () => this._getClient().send(new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: normalized,
        })),
        { operation: 's3.delete' }
      );
      logger.info('Storage delete completed', { provider: 's3', module: 'storage', success: true });
      return true;
    } catch (e) {
      logger.warn('Storage delete failed', { provider: 's3', module: 'storage', error: e.message });
      return false;
    }
  }

  async getStream({ key }) {
    const normalized = normalizeObjectKey(key);
    logger.info('Storage download started', { provider: 's3', module: 'storage' });
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const result = await withRetry(
        () => this._getClient().send(new GetObjectCommand({
          Bucket: this.bucket,
          Key: normalized,
        })),
        { operation: 's3.getStream' }
      );
      return result.Body;
    } catch (err) {
      const status = err.$metadata?.httpStatusCode || err.status;
      if (status === 404 || err.name === 'NoSuchKey' || err.Code === 'NoSuchKey') {
        throw new StorageError('File not found', { status: 404, code: 'OBJECT_NOT_FOUND', cause: err });
      }
      logger.error('Storage download failed', { provider: 's3', module: 'storage', error: err.message });
      throw new StorageError(err.message || 'S3 download failed', {
        status: status || 502,
        code: err.name || 'DOWNLOAD_FAILED',
        cause: err,
      });
    }
  }

  async getPresignedUrl({ key, expiresIn = 3600 }) {
    const normalized = normalizeObjectKey(key);
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: normalized,
      });
      return getSignedUrl(this._getClient(), command, { expiresIn });
    } catch (err) {
      logger.error('Storage presigned URL failed', { provider: 's3', module: 'storage', error: err.message });
      throw new StorageError(err.message || 'Failed to generate S3 presigned URL', {
        status: 500,
        code: 'PRESIGN_FAILED',
        cause: err,
      });
    }
  }
}

module.exports = S3StorageProvider;
