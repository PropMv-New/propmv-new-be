/**
 * ------------------------------------------------------------------
 * File: mockS3.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for mockS3.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config/default');
const logger = require('../../common/logger');
const { UPLOAD_PROPERTY_SUBDIR, UPLOAD_TENANT_SUBDIR, UPLOAD_PROFILE_SUBDIR, UPLOAD_LEASE_SUBDIR } = require('../../common/constants/uploads');

// Mock S3 client that stores files under configured mockDir and exposes URLs under baseUrl
class MockS3 {
  constructor() {
    // baseUrl must be provided via environment (S3_BASE_URL in your .env).
    // Do not hardcode a value here; rely on the environment file as requested.
    this.baseUrl = config.s3 && config.s3.baseUrl;
    if (!this.baseUrl) {
      logger.warn('Warning: S3_BASE_URL not set in environment. Using empty base URL. Set S3_BASE_URL in .env to change this.');
      this.baseUrl = '';
    }
    
    // Check profile to determine storage location
    const profile = config.profile || 'local';
    
    if (profile === 'local') {
      // For local profile, use uploads folder with same structure
      this.mockDir = path.join(__dirname, '../../../uploads');
    } else {
      // For other profiles, use mock_s3 folder
      this.mockDir = config.s3.mockDir || path.join(__dirname, '../../../mock_s3');
    }
    this.mockDir = path.resolve(this.mockDir);

    if (!fs.existsSync(this.mockDir)) fs.mkdirSync(this.mockDir, { recursive: true });
    
    // load upload folder mapping from config or environment
    let envMap = {};
    try {
      envMap = process.env.S3_UPLOAD_FOLDERS ? JSON.parse(process.env.S3_UPLOAD_FOLDERS) : {};
    } catch (e) {
      logger.warn('Failed to parse S3_UPLOAD_FOLDERS env var as JSON. Ignoring it. Example: {"property":"properties","profile":"profile-pictures"}');
      envMap = {};
    }
    this.uploadFolders = (config.s3 && config.s3.uploadFolders) || envMap || {};
  }

  // Simulate upload. Supports two call signatures for convenience:
  // 1) upload({ localFilePath, key, contentType? }) - moves a file from disk into mock storage
  // 2) upload(key, buffer) - writes a buffer directly into mock storage at the given key
  async upload(arg1, arg2) {
    let key;
    let destPath;

    if (typeof arg1 === 'object' && arg1 !== null && arg1.key && arg1.localFilePath) {
      // signature: upload({ localFilePath, key })
      key = arg1.key;
      destPath = path.join(this.mockDir, key);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      // move file
      await fs.promises.rename(arg1.localFilePath, destPath);
    } else if (typeof arg1 === 'string' && Buffer.isBuffer(arg2)) {
      // signature: upload(key, buffer)
      key = arg1;
      destPath = path.join(this.mockDir, key);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      // write buffer
      await fs.promises.writeFile(destPath, arg2);
    } else {
      throw new Error('Invalid arguments to mockS3.upload. Expected ( { localFilePath, key } ) or ( key, buffer ).');
    }

    const url = `${this.baseUrl}/${key.replace(/\\/g, '/')}`;
    return { Location: url, Key: key };
  }

  // helper to generate a key for property images
  getKeyForProperty(propertyId, filename, userId) {
    return this.getKey('property', filename, userId);
  }

  // helper to generate a key for tenant documents
  getKeyForTenant(tenantId, filename, userId) {
    return this.getKey('tenant', filename, userId);
  }

  // helper to generate a key for lease documents
  getKeyForLease(leaseId, filename, userId) {
    return this.getKey('lease', filename, userId);
  }

  // helper to generate a key for profile pictures
  getKeyForProfile(userId, filename) {
    return this.getKey('profile', filename, userId);
  }

  // Generic key builder with user-specific folder structure
  // Format: <MODULE_FOLDER>/<USER_ID>/<filename>
  getKey(documentType, filename, userId) {
    const raw = (filename || '').toString();
    const safeName = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Get module folder name from mapping
    const map = this.uploadFolders || {};
    const folderFromMap = map[documentType];
    const moduleFolder = folderFromMap || (
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

    // Uniquify file names to avoid collisions
    const prefix = `${Date.now()}-${require('crypto').randomBytes(6).toString('hex')}`;
    const finalName = safeName && safeName.length > 0 ? `${prefix}-${safeName}` : `${prefix}`;
    
    // Build path with user folder: <MODULE>/<USER_ID>/<filename>
    if (userId) {
      return path.posix.join(moduleFolder, String(userId), finalName);
    }
    
    // Fallback without userId (backward compatibility)
    return path.posix.join(moduleFolder, finalName);
  }

  // delete a stored mock object by key (used for cleanup on rollback)
  async delete({ key }) {
    const target = path.join(this.mockDir, key);
    try {
      if (fs.existsSync(target)) await fs.promises.unlink(target);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Get stream for downloading files
  async getStream({ key }) {
    const filePath = path.join(this.mockDir, key.replace(/\//g, path.sep));
    if (!fs.existsSync(filePath)) {
      throw Object.assign(new Error('File not found'), { status: 404 });
    }
    return fs.createReadStream(filePath);
  }

  // Generate mock presigned URL (for consistency with AWS S3)
  async getPresignedUrl({ key, expiresIn = 3600 }) {
    // For mock S3, return the direct URL since we don't have real presigning
    return `${this.baseUrl}/${key.replace(/\\/g, '/')}`;
  }
}

module.exports = new MockS3();
