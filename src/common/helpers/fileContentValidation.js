/**
 * ------------------------------------------------------------------
 * File: fileContentValidation.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for fileContentValidation.
 *
 * Used By:
 * fileValidationHelper
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { EXTENSION_TO_MIME } = require('../constants/uploadFileTypes');

const SIGNATURE_CHECKS = {
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  'application/pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }],
  'application/msword': [{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }],
  'application/vnd.ms-excel': [{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  ],
  'video/mp4': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  'video/x-m4v': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  'video/3gpp': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  'video/quicktime': [
    { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
    { offset: 4, bytes: [0x6d, 0x6f, 0x6f, 0x76] },
    { offset: 4, bytes: [0x6d, 0x64, 0x61, 0x74] },
  ],
  'video/webm': [{ offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
  'video/mpeg': [
    { offset: 0, bytes: [0x00, 0x00, 0x01, 0xba] },
    { offset: 0, bytes: [0x00, 0x00, 0x01, 0xb3] },
  ],
  'video/x-msvideo': [
    {
      offset: 0,
      bytes: [0x52, 0x49, 0x46, 0x46],
      extraAtOffset: 8,
      extraBytes: [0x41, 0x56, 0x49, 0x20],
    },
  ],
  'application/json': [{ custom: 'json' }],
  'text/csv': [{ custom: 'text' }],
  'text/plain': [{ custom: 'text' }],
};

const CONTENT_SAMPLE_BYTES = 8192;

/**
 * matches Signature
 *
 * Performs logic operations for matchesSignature.
 *
 * @param buffer - Request/input argument
 * @param check - Request/input argument
 * @returns Operations result
 */
function matchesSignature(buffer, check) {
  if (check.custom === 'text') {
    return isPlainTextBuffer(buffer);
  }
  if (check.custom === 'json') {
    return isJsonBuffer(buffer);
  }
  if (!buffer || buffer.length < check.offset + check.bytes.length) {
    return false;
  }
  for (let i = 0; i < check.bytes.length; i += 1) {
    if (buffer[check.offset + i] !== check.bytes[i]) {
      return false;
    }
  }
  if (check.extraAtOffset !== undefined && check.extraBytes) {
    if (buffer.length < check.extraAtOffset + check.extraBytes.length) return false;
    for (let i = 0; i < check.extraBytes.length; i += 1) {
      if (buffer[check.extraAtOffset + i] !== check.extraBytes[i]) {
        return false;
      }
    }
  }
  return true;
}

/**
 * is Plain Text Buffer
 *
 * Performs logic operations for isPlainTextBuffer.
 *
 * @param buffer - Request/input argument
 * @returns Operations result
 */
function isPlainTextBuffer(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, CONTENT_SAMPLE_BYTES));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return false;
  }
  return true;
}

/**
 * is Json Buffer
 *
 * Performs logic operations for isJsonBuffer.
 *
 * @param buffer - Request/input argument
 * @returns Operations result
 */
function isJsonBuffer(buffer) {
  if (!isPlainTextBuffer(buffer)) return false;
  const trimmed = buffer.toString('utf8', 0, Math.min(buffer.length, CONTENT_SAMPLE_BYTES)).trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * detect Mime From Buffer
 *
 * Performs logic operations for detectMimeFromBuffer.
 *
 * @param buffer - Request/input argument
 * @param ext - Request/input argument
 * @returns Operations result
 */
function detectMimeFromBuffer(buffer, ext) {
  const normalizedExt = ext && ext.startsWith('.') ? ext.toLowerCase() : `.${String(ext || '').toLowerCase()}`;
  for (const [mime, checks] of Object.entries(SIGNATURE_CHECKS)) {
    if (checks.some((check) => matchesSignature(buffer, check))) {
      if (mime === 'text/plain' && normalizedExt === '.csv') return 'text/csv';
      if (mime === 'text/plain' && normalizedExt === '.json') return 'application/json';
      return mime;
    }
  }
  return null;
}

/**
 * normalize Extension
 *
 * Performs logic operations for normalizeExtension.
 *
 * @param ext - Request/input argument
 * @returns Operations result
 */
function normalizeExtension(ext) {
  if (!ext) return '';
  const value = String(ext).toLowerCase();
  if (value.startsWith('.')) return value;
  if (value.includes('.')) return path.extname(value);
  return `.${value}`;
}

/**
 * validate Buffer Content
 *
 * Performs logic operations for validateBufferContent.
 *
 * @param buffer - Request/input argument
 * @param ext - Request/input argument
 * @param declaredMime - Request/input argument
 * @returns Operations result
 */
function validateBufferContent(buffer, ext, declaredMime) {
  const normalizedExt = normalizeExtension(ext);
  const expectedMimeFromExt = EXTENSION_TO_MIME[normalizedExt];
  const mime = (declaredMime || '').toLowerCase();

  if (!expectedMimeFromExt) {
    return { valid: false, reason: 'Unsupported file extension' };
  }

  if (mime && mime !== expectedMimeFromExt) {
    const altExtensions = Object.entries(EXTENSION_TO_MIME)
      .filter(([, value]) => value === mime)
      .map(([key]) => key);
    if (!altExtensions.includes(normalizedExt)) {
      return { valid: false, reason: 'File extension does not match declared content type' };
    }
  }

  const effectiveMime = expectedMimeFromExt;
  const checks = SIGNATURE_CHECKS[effectiveMime];
  if (!checks || checks.length === 0) {
    return { valid: false, reason: 'Unsupported content type' };
  }

  const contentValid = checks.some((check) => matchesSignature(buffer, check));
  if (!contentValid) {
    return { valid: false, reason: 'File content does not match its type' };
  }

  const detectedMime = detectMimeFromBuffer(buffer, normalizedExt);
  if (detectedMime && detectedMime !== effectiveMime) {
    const zipBasedOffice = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (!(zipBasedOffice.includes(detectedMime) && zipBasedOffice.includes(effectiveMime))) {
      return { valid: false, reason: 'File content does not match its extension' };
    }
  }

  return { valid: true, detectedMime: detectedMime || effectiveMime };
}

async function readContentSample(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(CONTENT_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CONTENT_SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function validateUploadedFileContent(file) {
  if (!file || !file.path) {
    return { valid: false, reason: 'No file provided' };
  }

  let buffer;
  try {
    buffer = await readContentSample(file.path);
  } catch (err) {
    return { valid: false, reason: 'Unable to read uploaded file for validation' };
  }

  if (!buffer || buffer.length === 0) {
    return { valid: false, reason: 'Empty or corrupted file' };
  }

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  return validateBufferContent(buffer, ext, file.mimetype);
}

module.exports = {
  validateBufferContent,
  validateUploadedFileContent,
  detectMimeFromBuffer,
  matchesSignature,
  isPlainTextBuffer,
  isJsonBuffer,
};
