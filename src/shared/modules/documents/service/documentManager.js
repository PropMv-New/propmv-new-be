/**
 * ------------------------------------------------------------------
 * File: documentManager.js
 * Module: Documents Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for documentManager.
 *
 * Used By:
 * expense.service, email.controller, email.service
 * ------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const config = require('../../../../config/default');
const storageClient = require('../../../../integrations/storage');
const DocumentMetadata = require('../model/documentMetadata.model');
const logger = require('../../../../common/logger');

/**
 * DocumentManager
 *
 * Represents the Document Manager controller/model class.
 */
class DocumentManager {
  constructor({ s3 = storageClient, metadataModel = DocumentMetadata, cfg = config, log = logger } = {}) {
    this.s3 = s3;
    this.DocumentMetadata = metadataModel;
    this.config = cfg;
    this.logger = log;
  }

  _resolveBucketAndRegion() {
    const provider = this.s3 || {};
    if (provider.bucket && provider.region) {
      return { bucketName: provider.bucket, region: provider.region };
    }
    const cfg = this.config || {};
    return {
      bucketName: (cfg.s3 && cfg.s3.bucket) || process.env.S3_BUCKET || process.env.AZURE_STORAGE_CONTAINER || 'mock-bucket',
      region: (cfg.s3 && cfg.s3.region) || process.env.AWS_REGION || 'mock-region',
    };
  }

  // Upload files (array of multer file objects) and create DocumentMetadata docs inside optional mongoose session
  async uploadAndCreateMetadata(files = [], { documentType = 'uploads', ownerId = null, userId = null, session = null } = {}) {
    if (!Array.isArray(files) || files.length === 0) return [];
    void ownerId;

    const createdMetadata = [];
    const { bucketName, region } = this._resolveBucketAndRegion();

    for (const file of files) {
      if (!file || (file.size || 0) < 1) {
        this.logger.warn('DocumentManager.uploadAndCreateMetadata - skipped empty file', { name: file && file.originalname });
        try { if (file && file.path && fs.existsSync(file.path)) await fs.promises.unlink(file.path); } catch (e) { /* ignore */ }
        continue;
      }
      try {
        const filename = file.originalname || file.filename || `file-${Date.now()}`;
        const key = this.s3.getKey ? this.s3.getKey(documentType, filename, userId) : `${documentType}/${Date.now()}-${filename}`;
        const contentType = file.mimetype || 'application/octet-stream';

        const uploadResult = await this.s3.upload({
          localFilePath: file.path,
          key,
          contentType,
        });

        const metadataDoc = await this.DocumentMetadata.create([{
          key: uploadResult.Key || key,
          s3Location: uploadResult.Location || undefined,
          originalName: file.originalname || filename,
          bucketName,
          region,
          size: file.size || 0,
          contentType,
        }], session ? { session } : {});

        createdMetadata.push(metadataDoc[0]);

        // Try to remove temp file (best-effort) - many adapters already move/delete it
        try { await fs.promises.unlink(file.path); } catch (e) { /* ignore */ }
      } catch (err) {
        this.logger.error('DocumentManager.uploadAndCreateMetadata - failed uploading/creating metadata', { err: err.message, file: file && file.originalname });
        // Attempt best-effort cleanup of temp file
        try { if (file && file.path && fs.existsSync(file.path)) await fs.promises.unlink(file.path); } catch (e) { this.logger.warn('Failed removing temp file after upload failure', e.message); }
        throw err;
      }
    }

    return createdMetadata;
  }

  // Get a readable stream for a metadata id (tries s3Client.getStream then mock dir)
  async getStreamByMetadataId(metadataId) {
    if (!metadataId) throw Object.assign(new Error('metadataId is required'), { status: 400 });
    if (!mongoose.Types.ObjectId.isValid(String(metadataId))) throw Object.assign(new Error('Invalid metadataId'), { status: 400 });

    const meta = await this.DocumentMetadata.findById(metadataId).lean();
    if (!meta) throw Object.assign(new Error('Document metadata not found'), { status: 404 });
    if (meta.isDeleted) throw Object.assign(new Error('Document was deleted'), { status: 404 });

    const key = meta.key;
    if (!key) throw Object.assign(new Error('Document storage key is missing'), { status: 500 });

    // Try S3 / Azure stream API - providers return a Readable (or SdkStreamMixin) body
    if (this.s3 && typeof this.s3.getStream === 'function') {
      try {
        const fileStream = await this.s3.getStream({ key });
        if (fileStream && fileStream.stream) {
          return {
            stream: fileStream.stream,
            fileName: fileStream.fileName || meta.originalName,
            contentType: fileStream.contentType || meta.contentType,
          };
        }
        if (fileStream) {
          return {
            stream: fileStream,
            fileName: meta.originalName,
            contentType: meta.contentType || 'application/octet-stream',
          };
        }
      } catch (e) {
        this.logger.warn('s3.getStream failed, falling back to disk', e.message);
      }
    }

    // Fallback to mockS3 dir
    const mockDir = (this.config.s3 && this.config.s3.mockDir) || path.join(__dirname, '../../../../mock_s3');
    const filePath = path.join(mockDir, key.replace(/\//g, path.sep));
    if (!fs.existsSync(filePath)) throw Object.assign(new Error('File not found on disk'), { status: 404 });
    const stream = fs.createReadStream(filePath);
    return { stream, fileName: meta.originalName || path.basename(filePath), contentType: meta.contentType || 'application/octet-stream' };
  }

  // Delete metadata: best-effort delete from s3 and soft-delete metadata record
  async deleteMetadata(metadataId) {
    if (!metadataId) throw Object.assign(new Error('metadataId is required'), { status: 400 });
    const meta = await this.DocumentMetadata.findById(metadataId);
    if (!meta) throw Object.assign(new Error('Document metadata not found'), { status: 404 });

    try {
      if (this.s3 && typeof this.s3.delete === 'function') {
        await this.s3.delete({ key: meta.key });
      }
    } catch (e) {
      this.logger.warn('Failed to delete object from s3/mock', e.message);
    }

    meta.isDeleted = true;
    await meta.save();
    return true;
  }
}

module.exports = DocumentManager;
