/**
 * ------------------------------------------------------------------
 * File: fileMetadataValidation.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for fileMetadataValidation.
 *
 * Used By:
 * fileValidationHelper
 * ------------------------------------------------------------------
 */

const path = require('path');
const { getProfile } = require('../constants/uploadFileTypes');

const MAX_FILENAME_LENGTH = Number(process.env.UPLOAD_MAX_FILENAME_LENGTH || 255);

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif', '.dll', '.sys',
  '.sh', '.bash', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.mjs', '.cjs',
  '.jar', '.war', '.php', '.phtml', '.asp', '.aspx', '.jsp', '.jspx',
  '.html', '.htm', '.xhtml', '.svg', '.xml', '.xsl', '.xslt',
  '.reg', '.inf', '.hta', '.application', '.gadget', '.msc', '.lnk',
  '.app', '.deb', '.rpm', '.dmg', '.pkg', '.run', '.bin',
]);

const BLOCKED_MIME_PREFIXES = [
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-sh',
  'application/javascript',
  'text/javascript',
  'application/x-php',
  'application/x-httpd-php',
];

const INVALID_FILENAME_CHARS = /[\u0000<>:"/\\|?*\x00-\x1f]/;

/**
 * get Display Name
 *
 * Performs logic operations for getDisplayName.
 *
 * @param file - Request/input argument
 * @returns Operations result
 */
function getDisplayName(file) {
  return file?.originalname || file?.filename || file?.name || '';
}

/**
 * get Basename
 *
 * Performs logic operations for getBasename.
 *
 * @param filename - Request/input argument
 * @returns Operations result
 */
function getBasename(filename) {
  const normalized = String(filename || '').replace(/\\/g, '/');
  return path.basename(normalized);
}

/**
 * get All Extensions
 *
 * Performs logic operations for getAllExtensions.
 *
 * @param filename - Request/input argument
 * @returns Operations result
 */
function getAllExtensions(filename) {
  const base = getBasename(filename);
  const parts = base.toLowerCase().split('.');
  if (parts.length <= 1) return [];
  const extensions = [];
  for (let i = 1; i < parts.length; i += 1) {
    extensions.push(`.${parts[i]}`);
  }
  return extensions;
}

/**
 * has Blocked Extension
 *
 * Performs logic operations for hasBlockedExtension.
 *
 * @param filename - Request/input argument
 * @returns Operations result
 */
function hasBlockedExtension(filename) {
  return getAllExtensions(filename).some((ext) => BLOCKED_EXTENSIONS.has(ext));
}

/**
 * has Double Extension Risk
 *
 * Performs logic operations for hasDoubleExtensionRisk.
 *
 * @param filename - Request/input argument
 * @param allowedExtensions - Request/input argument
 * @returns Operations result
 */
function hasDoubleExtensionRisk(filename, allowedExtensions = []) {
  const extensions = getAllExtensions(filename);
  if (extensions.length <= 1) return false;
  const allowed = new Set(allowedExtensions.map((ext) => ext.toLowerCase()));
  const trailing = extensions[extensions.length - 1];
  if (!allowed.has(trailing)) return true;
  return extensions.slice(0, -1).some((ext) => BLOCKED_EXTENSIONS.has(ext));
}

/**
 * is Blocked Mime
 *
 * Performs logic operations for isBlockedMime.
 *
 * @param mime - Request/input argument
 * @returns Operations result
 */
function isBlockedMime(mime) {
  const normalized = String(mime || '').toLowerCase().trim();
  if (!normalized) return false;
  return BLOCKED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Validates filename, size, and security metadata before content inspection.
 * @param {object} file - multer file or { originalname, mimetype, size }
 * @param {string} profileName
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateFileMetadata(file, profileName) {
  const displayName = getDisplayName(file);
  if (!displayName) {
    return { valid: false, reason: 'Filename is required' };
  }

  if (displayName !== getBasename(displayName)) {
    return { valid: false, reason: 'Invalid filename: path traversal is not allowed' };
  }

  if (displayName.startsWith('.') || displayName.includes('..')) {
    return { valid: false, reason: 'Invalid filename: hidden or relative paths are not allowed' };
  }

  if (displayName.length > MAX_FILENAME_LENGTH) {
    return { valid: false, reason: `Filename exceeds maximum length of ${MAX_FILENAME_LENGTH} characters` };
  }

  if (INVALID_FILENAME_CHARS.test(displayName)) {
    return { valid: false, reason: 'Filename contains invalid characters' };
  }

  const size = file?.size;
  if (size !== undefined && size !== null) {
    if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
      return { valid: false, reason: 'Empty files are not allowed' };
    }

    const profile = getProfile(profileName);
    const maxSizeBytes = profile.maxSizeBytes;
    if (maxSizeBytes && Number(size) > maxSizeBytes) {
      const limitMb = Math.round(maxSizeBytes / (1024 * 1024));
      return { valid: false, reason: `File size exceeds ${limitMb}MB limit for this document type` };
    }
  }

  const profile = getProfile(profileName);

  if (hasBlockedExtension(displayName)) {
    return { valid: false, reason: 'Executable or script files are not allowed' };
  }

  if (hasDoubleExtensionRisk(displayName, profile.extensions)) {
    return { valid: false, reason: 'Files with suspicious double extensions are not allowed' };
  }

  const mime = (file?.mimetype || '').toLowerCase();
  if (isBlockedMime(mime)) {
    return { valid: false, reason: 'Unsupported or dangerous file type' };
  }

  const ext = path.extname(displayName).toLowerCase();
  if (!ext || !profile.extensions.includes(ext)) {
    return { valid: false, reason: profile.errorMessage };
  }

  if (mime && !profile.mimeTypes.includes(mime)) {
    return { valid: false, reason: 'File content type does not match allowed types for this upload' };
  }

  return { valid: true };
}

module.exports = {
  validateFileMetadata,
  getBasename,
  hasBlockedExtension,
  hasDoubleExtensionRisk,
  BLOCKED_EXTENSIONS,
  MAX_FILENAME_LENGTH,
};
