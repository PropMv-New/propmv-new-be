const path = require('path');
const DocumentMetadata = require('../../shared/modules/documents/model/documentMetadata.model');
const s3Client = require('../../integrations/s3');
const config = require('../../config/default');

const DEFAULT_ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls'];
const DEFAULT_MAX_SIZE = 20 * 1024 * 1024;

/**
 * Upload note attachment files to object storage and create DocumentMetadata records.
 * Returns an array of DocumentMetadata ObjectIds.
 */
async function uploadNoteAttachmentFiles({
  entityType = 'property',
  entityId,
  files = [],
  allowedExts = DEFAULT_ALLOWED_EXTS,
  maxSize = DEFAULT_MAX_SIZE,
} = {}) {
  if (!entityId) {
    throw Object.assign(new Error('entityId is required for note attachment upload'), { status: 400 });
  }
  if (!Array.isArray(files) || files.length === 0) return [];

  const uploadedMetaIds = [];
  const folderHint = entityType === 'owner' ? 'owner-notes' : 'property-notes';

  for (const f of files) {
    const originalName = f.originalname || f.filename || 'attachment';
    const ext = path.extname(originalName).toLowerCase();
    if (!allowedExts.includes(ext)) {
      throw Object.assign(new Error(`File extension ${ext} not allowed`), { status: 400 });
    }
    if (f.size > maxSize) {
      throw Object.assign(new Error(`File ${originalName} exceeds max size ${Math.round(maxSize / (1024 * 1024))}MB`), {
        status: 400,
      });
    }

    const safeFilename = path.basename(originalName);
    let key;
    if (typeof s3Client.getKeyForProperty === 'function' && entityType === 'property') {
      key = s3Client.getKeyForProperty(entityId, safeFilename);
    } else if (typeof s3Client.getKey === 'function') {
      key = s3Client.getKey(folderHint, safeFilename, entityId);
    } else {
      key = `${folderHint}/${entityId}/${Date.now()}_${safeFilename}`;
    }

    const result = await s3Client.upload({
      localFilePath: f.path,
      key,
      contentType: f.mimetype || 'application/octet-stream',
    });

    const bucketName =
      (config.s3 && config.s3.bucketName) || process.env.S3_BUCKET || 'mock-bucket';
    const region = (config.s3 && config.s3.region) || process.env.AWS_REGION || 'mock-region';
    const metadataDoc = await DocumentMetadata.create({
      key: result.Key || key,
      bucketName,
      region,
      size: f.size || 0,
      contentType: f.mimetype || 'application/octet-stream',
      originalName,
      s3Location:
        result.Location ||
        (s3Client.baseUrl ? `${s3Client.baseUrl}/${key}` : `/${key}`),
    });
    uploadedMetaIds.push(metadataDoc._id);
  }

  return uploadedMetaIds;
}

function isLegacyLocalNoteAttachment(att) {
  return Boolean(
    att &&
      typeof att === 'object' &&
      !Array.isArray(att) &&
      (att.path || att.filename || att.mimetype) &&
      !att.key &&
      !att.originalName
  );
}

module.exports = {
  uploadNoteAttachmentFiles,
  isLegacyLocalNoteAttachment,
  DEFAULT_ALLOWED_EXTS,
  DEFAULT_MAX_SIZE,
};
