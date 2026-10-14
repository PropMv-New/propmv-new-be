/**
 * ------------------------------------------------------------------
 * File: fileDownloadHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Reliably stream/buffer binary file downloads with correct headers
 * and filenames so saved files open correctly.
 * ------------------------------------------------------------------
 */

const path = require('path');
const { EXTENSION_TO_MIME, MIME_TO_EXTENSIONS } = require('../constants/uploadFileTypes');

/**
 * Convert a Readable / AWS SdkStreamMixin / Buffer into a Buffer.
 */
async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream.transformToByteArray === 'function') {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extensionForContentType(contentType) {
  if (!contentType) return '';
  const base = String(contentType).split(';')[0].trim().toLowerCase();
  const extensions = MIME_TO_EXTENSIONS[base];
  return extensions && extensions[0] ? extensions[0] : '';
}

function contentTypeForFileName(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!ext) return null;
  return EXTENSION_TO_MIME[ext] || null;
}

/**
 * Ensure the download filename has an extension matching content type when missing.
 */
function ensureDownloadFileName(fileName, contentType) {
  const raw = String(fileName || 'download').replace(/["\r\n]/g, '_').trim() || 'download';
  const base = path.basename(raw);
  if (path.extname(base)) return base;
  const ext = extensionForContentType(contentType);
  return ext ? `${base}${ext}` : base;
}

/**
 * Send a binary download response.
 * Buffers the stream so AWS SDK / Azure streams are not truncated or
 * corrupted by mid-stream JSON error handlers / gzip edge cases.
 */
async function sendBinaryDownload(res, { stream, buffer, fileName, contentType }) {
  const resolvedType =
    contentType ||
    contentTypeForFileName(fileName) ||
    'application/octet-stream';
  const safeName = ensureDownloadFileName(fileName, resolvedType);
  const body = buffer != null ? (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)) : await streamToBuffer(stream);

  if (!body || body.length < 1) {
    const err = new Error('File is empty or could not be read');
    err.status = 404;
    throw err;
  }

  // Prevent compression middleware from transforming binary payloads
  res.setHeader('Cache-Control', 'no-transform');
  res.setHeader('Content-Type', resolvedType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(body.length));
  return res.status(200).end(body);
}

module.exports = {
  streamToBuffer,
  extensionForContentType,
  contentTypeForFileName,
  ensureDownloadFileName,
  sendBinaryDownload,
};
