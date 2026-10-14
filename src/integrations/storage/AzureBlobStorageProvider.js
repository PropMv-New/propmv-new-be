const fs = require('fs');
const config = require('../../config/default');
const logger = require('../../common/logger');
const StorageProvider = require('./StorageProvider');
const { StorageError, withRetry } = require('./errors');
const { buildObjectKey, normalizeObjectKey } = require('./keyBuilder');
const { ClockService, DateUtil } = require('../../common/date');

/**
 * Azure Blob Storage provider - same interface as S3StorageProvider.
 */
class AzureBlobStorageProvider extends StorageProvider {
  constructor(options = {}) {
    super();
    const azureCfg = (config.storage && config.storage.azure) || {};
    const s3Cfg = config.s3 || {};

    this.accountName = options.accountName || process.env.AZURE_STORAGE_ACCOUNT_NAME || azureCfg.accountName || null;
    this.accountKey = options.accountKey || process.env.AZURE_STORAGE_ACCOUNT_KEY || azureCfg.accountKey || null;
    this.connectionString =
      options.connectionString ||
      process.env.AZURE_STORAGE_CONNECTION_STRING ||
      azureCfg.connectionString ||
      null;
    this.container =
      options.container ||
      process.env.AZURE_STORAGE_CONTAINER ||
      azureCfg.container ||
      null;
    this.baseUrl =
      options.baseUrl ||
      process.env.AZURE_STORAGE_BASE_URL ||
      azureCfg.baseUrl ||
      null;
    this.uploadFolders = options.uploadFolders || s3Cfg.uploadFolders || {};

    // DocumentMetadata compatibility: bucketName = container, region = azure|<account>
    this.bucket = this.container;
    this.region = this.accountName ? `azure:${this.accountName}` : 'azure';

    this._serviceClient = null;
    this._containerClient = null;

    if (!this.container) {
      throw new StorageError('AZURE_STORAGE_CONTAINER is required when STORAGE_PROVIDER=azure', {
        status: 500,
        code: 'MISSING_CREDENTIALS',
      });
    }
    if (!this.connectionString && !(this.accountName && this.accountKey)) {
      throw new StorageError(
        'Azure credentials required: set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY',
        { status: 500, code: 'MISSING_CREDENTIALS' }
      );
    }

    logger.info('Storage provider selected', { provider: 'azure', module: 'storage' });
  }

  get providerName() {
    return 'azure';
  }

  _getServiceClient() {
    if (this._serviceClient) return this._serviceClient;
    const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

    if (this.connectionString) {
      this._serviceClient = BlobServiceClient.fromConnectionString(this.connectionString);
    } else {
      const credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);
      this._serviceClient = new BlobServiceClient(
        `https://${this.accountName}.blob.core.windows.net`,
        credential
      );
    }
    return this._serviceClient;
  }

  async _getContainerClient() {
    if (this._containerClient) return this._containerClient;
    const service = this._getServiceClient();
    const containerClient = service.getContainerClient(this.container);
    // Ensure container exists (idempotent)
    await withRetry(
      () => containerClient.createIfNotExists(),
      { operation: 'azure.createContainer' }
    );
    this._containerClient = containerClient;
    return containerClient;
  }

  _publicUrl(key) {
    if (this.baseUrl) {
      return `${String(this.baseUrl).replace(/\/$/, '')}/${key}`;
    }
    const account =
      this.accountName ||
      (this.connectionString && /AccountName=([^;]+)/i.exec(this.connectionString)?.[1]) ||
      'account';
    return `https://${account}.blob.core.windows.net/${this.container}/${key}`;
  }

  _resolveAccountCredentials() {
    if (this.accountName && this.accountKey) {
      return { accountName: this.accountName, accountKey: this.accountKey };
    }
    if (this.connectionString) {
      const nameMatch = /AccountName=([^;]+)/i.exec(this.connectionString);
      const keyMatch = /AccountKey=([^;]+)/i.exec(this.connectionString);
      if (nameMatch && keyMatch) {
        return { accountName: nameMatch[1], accountKey: keyMatch[1] };
      }
    }
    return null;
  }

  async upload(arg1, arg2) {
    logger.info('Storage upload started', { provider: 'azure', module: 'storage' });

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
      } else {
        throw new StorageError(
          'Invalid arguments to storage.upload. Use upload({ localFilePath, key, contentType? }) or upload(key, buffer)',
          { status: 400, code: 'INVALID_UPLOAD_ARGS' }
        );
      }

      const containerClient = await this._getContainerClient();
      const blockBlobClient = containerClient.getBlockBlobClient(key);

      await withRetry(
        () => blockBlobClient.uploadData(body, {
          blobHTTPHeaders: { blobContentType: contentType },
        }),
        { operation: 'azure.upload' }
      );

      if (removeLocal && localPath) {
        try { await fs.promises.unlink(localPath); } catch (e) { /* ignore */ }
      }

      const location = this._publicUrl(key);
      logger.info('Storage upload completed', {
        provider: 'azure',
        module: 'storage',
        success: true,
        fileSize: body.length,
      });
      return { Location: location, Key: key };
    } catch (err) {
      if (err instanceof StorageError) {
        logger.error('Storage upload failed', { provider: 'azure', module: 'storage', error: err.message, code: err.code });
        throw err;
      }
      logger.error('Storage upload failed', { provider: 'azure', module: 'storage', error: err.message });
      throw new StorageError(err.message || 'Azure Blob upload failed', {
        status: err.statusCode || 502,
        code: err.code || 'UPLOAD_FAILED',
        cause: err,
      });
    }
  }

  getKey(documentType, filename, userId) {
    return buildObjectKey(documentType, filename, userId, this.uploadFolders);
  }

  async delete({ key }) {
    const normalized = normalizeObjectKey(key);
    try {
      logger.info('Storage delete started', { provider: 'azure', module: 'storage' });
      const containerClient = await this._getContainerClient();
      await withRetry(
        () => containerClient.deleteBlob(normalized),
        { operation: 'azure.delete' }
      );
      logger.info('Storage delete completed', { provider: 'azure', module: 'storage', success: true });
      return true;
    } catch (e) {
      if (e.statusCode === 404) return true;
      logger.warn('Storage delete failed', { provider: 'azure', module: 'storage', error: e.message });
      return false;
    }
  }

  async getStream({ key }) {
    const normalized = normalizeObjectKey(key);
    logger.info('Storage download started', { provider: 'azure', module: 'storage' });
    try {
      const containerClient = await this._getContainerClient();
      const blobClient = containerClient.getBlobClient(normalized);
      const download = await withRetry(
        () => blobClient.download(0),
        { operation: 'azure.getStream' }
      );
      if (!download.readableStreamBody) {
        throw new StorageError('Empty response from Azure Blob', {
          status: 502,
          code: 'DOWNLOAD_FAILED',
        });
      }
      return download.readableStreamBody;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (err.statusCode === 404) {
        throw new StorageError('File not found', { status: 404, code: 'OBJECT_NOT_FOUND', cause: err });
      }
      logger.error('Storage download failed', { provider: 'azure', module: 'storage', error: err.message });
      throw new StorageError(err.message || 'Azure Blob download failed', {
        status: err.statusCode || 502,
        code: err.code || 'DOWNLOAD_FAILED',
        cause: err,
      });
    }
  }

  async getPresignedUrl({ key, expiresIn = 3600 }) {
    const normalized = normalizeObjectKey(key);
    try {
      const {
        generateBlobSASQueryParameters,
        BlobSASPermissions,
        StorageSharedKeyCredential,
      } = require('@azure/storage-blob');

      const creds = this._resolveAccountCredentials();
      if (!creds) {
        // Fall back to public URL when SAS cannot be signed (e.g. SAS token-only connection)
        logger.warn('Azure SAS credentials unavailable; returning public blob URL', {
          provider: 'azure',
          module: 'storage',
        });
        return this._publicUrl(normalized);
      }

      const startsOn = DateUtil.fromEpoch(ClockService.nowEpoch() - 5 * 60 * 1000);
      const expiresOn = DateUtil.fromEpoch(ClockService.nowEpoch() + expiresIn * 1000);
      const sas = generateBlobSASQueryParameters(
        {
          containerName: this.container,
          blobName: normalized,
          permissions: BlobSASPermissions.parse('r'),
          startsOn,
          expiresOn,
        },
        new StorageSharedKeyCredential(creds.accountName, creds.accountKey)
      ).toString();

      return `${this._publicUrl(normalized)}?${sas}`;
    } catch (err) {
      logger.error('Storage presigned URL failed', { provider: 'azure', module: 'storage', error: err.message });
      throw new StorageError(err.message || 'Failed to generate Azure SAS URL', {
        status: 500,
        code: 'PRESIGN_FAILED',
        cause: err,
      });
    }
  }
}

module.exports = AzureBlobStorageProvider;
