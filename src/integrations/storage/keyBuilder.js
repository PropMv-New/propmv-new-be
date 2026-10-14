const path = require('path');
const crypto = require('crypto');
const { ClockService, DateUtil } = require('../../common/date');

/**
 * Sanitize a filename to prevent path traversal and invalid object keys.
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
  const raw = (filename || '').toString().replace(/\\/g, '/');
  const base = path.posix.basename(raw);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Resolve the module folder prefix for a logical document type.
 * @param {string} documentType
 * @param {Record<string, string>} [uploadFolders]
 * @returns {string}
 */
function resolveModuleFolder(documentType, uploadFolders = {}) {
  const map = uploadFolders || {};
  if (map[documentType]) return map[documentType];
  const defaults = {
    property: 'Property',
    tenant: 'Tenants',
    lease: 'Lease & files',
    application: 'Applications',
    income: 'Income',
    expense: 'Expense',
    maintenance: 'Maintenance',
    message: 'Messaging',
    email: 'Email',
    listing: 'Listings',
    profile: 'profile-pictures',
    invoice: 'invoice-documents',
    damageReport: 'damage-reports',
    hoa: 'HOA Documents',
  };
  return defaults[documentType] || String(documentType || 'uploads');
}

/**
 * Build a unique, sanitized object key.
 * Format: <MODULE>/<USER_ID>/<timestamp-hex-filename>
 *
 * @param {string} documentType
 * @param {string} filename
 * @param {string|null|undefined} userId
 * @param {Record<string, string>} [uploadFolders]
 * @returns {string}
 */
function buildObjectKey(documentType, filename, userId, uploadFolders = {}) {
  const safeName = sanitizeFilename(filename);
  const moduleFolder = resolveModuleFolder(documentType, uploadFolders);
  const uniquePrefix = `${ClockService.nowEpoch()}-${crypto.randomBytes(6).toString('hex')}`;
  const finalName = safeName ? `${uniquePrefix}-${safeName}` : uniquePrefix;

  if (userId) {
    return path.posix.join(moduleFolder, String(userId), finalName);
  }
  return path.posix.join(moduleFolder, finalName);
}

/**
 * Normalize an object key (forward slashes, no leading slash, no traversal).
 * @param {string} key
 * @returns {string}
 */
function normalizeObjectKey(key) {
  if (!key || typeof key !== 'string') {
    throw new Error('Object key is required');
  }
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) {
    throw new Error('Invalid object key');
  }
  return normalized;
}

module.exports = {
  sanitizeFilename,
  resolveModuleFolder,
  buildObjectKey,
  normalizeObjectKey,
};
