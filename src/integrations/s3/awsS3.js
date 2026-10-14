/**
 * ------------------------------------------------------------------
 * File: awsS3.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for awsS3.
 *
 * Used By:
 * s3
 * ------------------------------------------------------------------
 */

// AWS S3 adapter using SDK v3 exclusively
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../../config/default');
const logger = require('../../common/logger');
const { ClockService, DateUtil } = require('../../common/date');

/**
 * AwsS3
 *
 * Represents the Aws S3 controller/model class.
 */
class AwsS3 {
  constructor() {
    this.bucket = process.env.S3_BUCKET || (config.s3 && config.s3.bucket);
    this.region = process.env.AWS_REGION || (config.s3 && config.s3.region);
    if (!this.bucket) {
      logger.warn('S3_BUCKET not configured; awsS3 will not function until configured');
    }
    let envMap = {};
    try {
      envMap = process.env.S3_UPLOAD_FOLDERS ? JSON.parse(process.env.S3_UPLOAD_FOLDERS) : {};
    } catch (e) {
      envMap = {};
    }
    this.uploadFolders = (config.s3 && config.s3.uploadFolders) || envMap || {};
    // client is lazy-initialized so env vars are always resolved first
    this._client = null;
  }

  _getClient() {
    if (this._client) return this._client;
    const { S3Client } = require('@aws-sdk/client-s3');
    this._client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      followRegionRedirects: true,
    });
    return this._client;
  }

  // upload({ localFilePath, key }) or upload(key, buffer)
  async upload(arg1, arg2) {
    if (!this.bucket) throw new Error('S3_BUCKET not configured');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');

    let key, body, contentType, removeLocal = false;
    if (typeof arg1 === 'object' && arg1 !== null && arg1.key && arg1.localFilePath) {
      key = arg1.key;
      body = await fs.promises.readFile(arg1.localFilePath);
      contentType = arg1.contentType || 'application/octet-stream';
      removeLocal = true;
    } else if (typeof arg1 === 'string' && Buffer.isBuffer(arg2)) {
      key = arg1;
      body = arg2;
      contentType = 'application/octet-stream';
    } else {
      throw new Error('Invalid arguments to awsS3.upload. Use upload({ localFilePath, key, contentType? }) or upload(key, buffer)');
    }

    const normalizedKey = key.replace(/\\/g, '/');
    await this._getClient().send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: normalizedKey,
      Body: body,
      ContentType: contentType,
    }));

    if (removeLocal) {
      try { await fs.promises.unlink(arg1.localFilePath); } catch (e) { /* ignore */ }
    }

    const location = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${normalizedKey}`;
    return { Location: location, Key: normalizedKey };
  }

  getKeyForProperty(propertyId, filename, userId) { return this.getKey('property', filename, userId); }
  getKeyForTenant(tenantId, filename, userId) { return this.getKey('tenant', filename, userId); }
  getKeyForLease(leaseId, filename, userId) { return this.getKey('lease', filename, userId); }
  getKeyForProfile(userId, filename) { return this.getKey('profile', filename, userId); }

  getKey(documentType, filename, userId) {
    const raw = (filename || '').toString();
    const safeName = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
    const map = this.uploadFolders || {};
    const moduleFolder = map[documentType] || (
      documentType === 'property' ? 'Property' :
      documentType === 'tenant' ? 'Tenants' :
      documentType === 'lease' ? 'Lease & files' :
      documentType === 'application' ? 'Applications' :
      documentType === 'income' ? 'Income' :
      documentType === 'expense' ? 'Expense' :
      documentType === 'maintenance' ? 'Maintenance' :
      documentType === 'message' ? 'Messaging' :
      documentType === 'email' ? 'Email' :
      documentType === 'listing' ? 'Listings' :
      documentType === 'profile' ? 'profile-pictures' :
      String(documentType || 'uploads')
    );
    const uniquePrefix = `${ClockService.nowEpoch()}-${crypto.randomBytes(6).toString('hex')}`;
    const finalName = safeName ? `${uniquePrefix}-${safeName}` : uniquePrefix;
    return userId
      ? path.posix.join(moduleFolder, String(userId), finalName)
      : path.posix.join(moduleFolder, finalName);
  }

  async delete({ key }) {
    if (!this.bucket) return false;
    try {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await this._getClient().send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key.replace(/\\/g, '/'),
      }));
      return true;
    } catch (e) {
      logger.warn('S3 delete failed:', e.message);
      return false;
    }
  }

  async getStream({ key }) {
    if (!this.bucket) throw new Error('S3_BUCKET not configured');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const result = await this._getClient().send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key.replace(/\\/g, '/'),
    }));
    return result.Body;
  }

  async getPresignedUrl({ key, expiresIn = 3600 }) {
    if (!this.bucket) throw new Error('S3_BUCKET not configured');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key.replace(/\\/g, '/'),
    });
    return getSignedUrl(this._getClient(), command, { expiresIn });
  }
}

module.exports = new AwsS3();
