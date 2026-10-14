/**
 * Abstract storage provider contract.
 *
 * All concrete providers (S3, Azure Blob, Mock) must implement this interface.
 * Application code must depend only on this contract - never on a specific cloud SDK.
 *
 * Supported call signatures (backward compatible with legacy MockS3/AwsS3):
 *   upload({ localFilePath, key, contentType? }) → { Location, Key }
 *   upload(key, buffer) → { Location, Key }
 *   delete({ key }) → boolean
 *   getStream({ key }) → Readable stream
 *   getPresignedUrl({ key, expiresIn? }) → string
 *   getKey(documentType, filename, userId?) → string
 *   getKeyForProperty / getKeyForTenant / getKeyForLease / getKeyForProfile
 */
class StorageProvider {
  constructor() {
    if (new.target === StorageProvider) {
      throw new Error('StorageProvider is abstract and cannot be instantiated directly');
    }
  }

  /** @returns {string} Provider id: 's3' | 'azure' | 'mock' */
  get providerName() {
    throw new Error('providerName getter not implemented');
  }

  async upload() {
    throw new Error('upload() not implemented');
  }

  async delete() {
    throw new Error('delete() not implemented');
  }

  async getStream() {
    throw new Error('getStream() not implemented');
  }

  async getPresignedUrl() {
    throw new Error('getPresignedUrl() not implemented');
  }

  getKey() {
    throw new Error('getKey() not implemented');
  }

  getKeyForProperty(propertyId, filename, userId) {
    return this.getKey('property', filename, userId);
  }

  getKeyForTenant(tenantId, filename, userId) {
    return this.getKey('tenant', filename, userId);
  }

  getKeyForLease(leaseId, filename, userId) {
    return this.getKey('lease', filename, userId);
  }

  getKeyForProfile(userId, filename) {
    return this.getKey('profile', filename, userId);
  }
}

module.exports = StorageProvider;
