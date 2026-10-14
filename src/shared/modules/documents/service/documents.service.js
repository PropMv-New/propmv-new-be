/**
 * ------------------------------------------------------------------
 * File: documents.service.js
 * Module: Documents Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.service, property.service, documents.controller, maintenance.service
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const logger = require('../../../../common/logger');

const DocumentMetadata = require('../model/documentMetadata.model');
const config = require('../../../../config/default');
const storageClient = require('../../../../integrations/storage');

async function getDocumentMetadata(metadataId) {
  if (!metadataId) {
    const err = new Error('metadata ID is required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(metadataId))) {
    const err = new Error('metadata ID must be a valid ObjectId');
    err.status = 400;
    throw err;
  }

  const metadata = await DocumentMetadata.findById(metadataId).lean();
  if (!metadata) {
    const err = new Error('Document metadata not found');
    err.status = 404;
    throw err;
  }
  return metadata;
}

/**
 * Build a public URL from stored metadata (provider-agnostic).
 * Prefers the Location persisted at upload time (s3Location).
 */
function buildPublicUrl(meta) {
  if (!meta) return null;
  if (meta.s3Location) return meta.s3Location;

  const cfg = config || {};
  const baseUrl = cfg.s3?.baseUrl || process.env.S3_BASE_URL || process.env.AZURE_STORAGE_BASE_URL || '';
  const bucketName = cfg.s3?.bucket || process.env.S3_BUCKET || process.env.AZURE_STORAGE_CONTAINER || null;
  const region = cfg.s3?.region || process.env.AWS_REGION || null;
  const key = meta.key ? String(meta.key).replace(/\\/g, '/') : null;

  if (baseUrl && key && !String(baseUrl).startsWith('/mock')) {
    return `${String(baseUrl).replace(/\/$/, '')}/${key}`;
  }

  // Azure-style region marker stored as azure:<account>
  if (meta.region && String(meta.region).startsWith('azure') && key) {
    const account =
      String(meta.region).includes(':')
        ? String(meta.region).split(':')[1]
        : (process.env.AZURE_STORAGE_ACCOUNT_NAME || 'account');
    const container = meta.bucketName || bucketName;
    return `https://${account}.blob.core.windows.net/${container}/${key}`;
  }

  if (bucketName && region && key) {
    return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
  }

  if (baseUrl && key) {
    return `${String(baseUrl).replace(/\/$/, '')}/${key}`;
  }

  return null;
}

async function getPresignedUrl(metadataId, expiresIn = 3600) {
  const metadata = await getDocumentMetadata(metadataId);

  if (storageClient && typeof storageClient.getPresignedUrl === 'function') {
    try {
      const url = await storageClient.getPresignedUrl({ key: metadata.key, expiresIn });
      return url;
    } catch (e) {
      logger.warn('Failed to generate presigned URL:', e.message);
      return buildPublicUrl(metadata);
    }
  }

  return buildPublicUrl(metadata);
}

async function getDocumentStream(metadataId) {
  const metadata = await getDocumentMetadata(metadataId);

  if (storageClient && typeof storageClient.getStream === 'function') {
    try {
      const fileStream = await storageClient.getStream({ key: metadata.key });
      if (fileStream && fileStream.stream) {
        return {
          stream: fileStream.stream,
          fileName: fileStream.fileName || metadata.originalName,
          contentType: fileStream.contentType || metadata.contentType,
        };
      }
      return {
        stream: fileStream,
        fileName: metadata.originalName,
        contentType: metadata.contentType,
      };
    } catch (e) {
      logger.warn('storage.getStream failed, falling back to disk read:', e.message);
    }
  }

  // Legacy fallback for pre-migration local files
  const s3MockDir = (config.s3 && config.s3.mockDir) || path.join(__dirname, '../../../../mock_s3');
  const filePath = path.join(s3MockDir, metadata.key.replace(/\//g, path.sep));
  if (!fs.existsSync(filePath)) {
    const err = new Error('File not found');
    err.status = 404;
    throw err;
  }
  const stream = fs.createReadStream(filePath);
  return {
    stream,
    fileName: metadata.originalName || path.basename(filePath),
    contentType: metadata.contentType || 'application/octet-stream',
  };
}

async function deleteDocument(metadataId, options = {}) {
  const metadata = await getDocumentMetadata(metadataId);
  void options;

  try {
    if (storageClient && typeof storageClient.delete === 'function') {
      await storageClient.delete({ key: metadata.key });
    }
  } catch (e) {
    logger.warn('Failed to delete object from storage:', e.message);
  }

  await DocumentMetadata.findByIdAndDelete(metadataId);
  return { success: true };
}

module.exports = {
  getDocumentMetadata,
  buildPublicUrl,
  getPresignedUrl,
  getDocumentStream,
  deleteDocument,
};
