/**
 * ------------------------------------------------------------------
 * File: property.controller.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * property.routes
 * ------------------------------------------------------------------
 */

const propertyService = require('../service/property.service');
const propertyExportService = require('../service/propertyExport.service');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { UPLOAD_PROPERTY_SUBDIR } = require('../../../../../common/constants/uploads');
const MSG = require('../messages/property.messages');
const { resolveCreatedBy, stripLegacyOwnerFields, resolvePropertySourcePortal } = require('../../../../../shared/utils/creatorScope.util');
const { ValidationError } = require('../../../../../common/exceptions');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const logger = require('../../../../../common/logger');
const { sanitizeFilename } = require('../../../../../integrations/storage/keyBuilder');
const { isSafeUploadPath } = require('../../../../../middleware/multipartValidator');

const ALLOWED_EXPORT_CONTENT_TYPES = new Set([
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

function safeContentType(value, fallback) {
  const ct = String(value || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_EXPORT_CONTENT_TYPES.has(ct) ? value : fallback;
}

const { cleanupUploadedFiles } = require('../../../../../middleware/multipartValidator');
const {
  multerImageFilter,
  multerImportFileFilter,
  multerNoteAttachmentFilter,
  assertUploadedFilesValid,
} = require('../../../../../common/helpers/fileValidationHelper');
const { uploadArray } = createUpload('images', null, {
  maxCount: 10,
  maxSizeBytes: 10 * 1024 * 1024,
  defaultSubdir: UPLOAD_PROPERTY_SUBDIR,
  fileFilter: multerImageFilter,
});
const { uploadArray: uploadFile, tempDir: importTempDir } = createUpload('file', null, {
  maxCount: 1,
  maxSizeBytes: 10 * 1024 * 1024,
  fileFilter: multerImportFileFilter,
});
const noteUpload = createUpload('attachments', null, {
  maxCount: 10,
  maxSizeBytes: 20 * 1024 * 1024,
  defaultSubdir: UPLOAD_PROPERTY_SUBDIR || 'property-notes',
  fileFilter: multerNoteAttachmentFilter,
});

/**
 * cleanup Temp Files
 *
 * Performs logic operations for cleanupTempFiles.
 *
 * @param files - Request/input argument
 * @returns Operations result
 */
function cleanupTempFiles(files) {
  if (!files || files.length === 0) return;
  const fs = require('fs');
  for (const f of files) {
    try {
      if (f && f.path && isSafeUploadPath(f.path)) fs.unlinkSync(f.path);
    } catch (ignore) {
      /* ignore */
    }
  }
}

/**
 * resolve Actor Id
 *
 * Performs logic operations for resolveActorId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function resolveActorId(req) {
  return req.user && (req.user._id || req.user.id);
}

async function applyLandlordPropertyQueryScope(req, q = {}) {
  const actorId = resolveActorId(req);
  const isAdmin = !!(req.user && req.user.isAdministrator);
  const companyId = req.user && req.user.companyId;
  q.createdBy = isAdmin
    ? { userId: actorId, isAdministrator: true, companyId }
    : resolveCreatedBy(q, actorId);
  q.sourcePortal = await resolvePropertySourcePortal(req.user);
  stripLegacyOwnerFields(q);
  return q;
}

const portfolioCache = new Map();
const CACHE_TTL = 60 * 1000;

const getPropertyById = async (req, res) => {
  const propertyId = req.params && req.params.id;
  if (!propertyId) {
    throw new ValidationError(MSG.PROPERTY_ID_REQUIRED);
  }
  const property = await propertyService.getPropertyByIdService(propertyId);
  res.json(property);
};

const getProperties = async (req, res) => {
  const startTime = Date.now();
  logger.info(`[API] Properties request received at ${new Date().toISOString()}`);
  const q = Object.assign({}, req.query || {});
  if (typeof q.pagesize !== 'undefined' && typeof q.pageSize === 'undefined') q.pageSize = q.pagesize;
  if (typeof q.page !== 'undefined') q.page = Number(q.page);
  if (typeof q.pageSize !== 'undefined') q.pageSize = Number(q.pageSize);

  await applyLandlordPropertyQueryScope(req, q);
  const result = await propertyService.getPropertiesService(q);

  if (q.createdBy) {
    const cacheKey = `portfolio_${q.sourcePortal}_${String(q.createdBy.userId || q.createdBy)}`;
    const cached = portfolioCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      result.portfolioOverview = cached.data;
    } else {
      const portfolioOverview = await propertyService.getPortfolioOverviewService(q.createdBy, q.sourcePortal);
      portfolioCache.set(cacheKey, { data: portfolioOverview, timestamp: Date.now() });
      result.portfolioOverview = portfolioOverview;
    }
  }

  result.responseTime = Date.now() - startTime;
  logger.info(`[API] Properties response sent: ${result.responseTime}ms`);
  return res.json(result);
};

const createProperty = async (req, res) => {
  try {
    const propertyData = req.body;
    if (!propertyData) {
      cleanupTempFiles(req.files);
      throw new ValidationError(MSG.PROPERTY_DATA_REQUIRED);
    }
    if (!propertyData.createdBy) {
      propertyData.createdBy = resolveActorId(req);
    }
    propertyData.sourcePortal = await resolvePropertySourcePortal(req.user);

    const files = req.files || [];
    if (files.length > 10) {
      cleanupTempFiles(files);
      throw new ValidationError(MSG.TOO_MANY_FILES);
    }

    const completeProperty = await propertyService.createPropertyWithMediaService(propertyData, files, {
      uploadedBy: resolveActorId(req),
    });

    return res.status(201).json(completeProperty);
  } catch (e) {
    cleanupTempFiles(req.files);
    throw e;
  }
};

const updateProperty = async (req, res) => {
  try {
    const createdBy = resolveCreatedBy(req.query || {}, resolveActorId(req));
    const propertyId = req.query && req.query.propertyId;

    if (!createdBy) {
      cleanupTempFiles(req.files);
      throw new ValidationError('createdBy is required');
    }
    if (!propertyId) {
      cleanupTempFiles(req.files);
      throw new ValidationError('propertyId is required as query param');
    }

    const propertyData = req.body;
    if (!propertyData) {
      cleanupTempFiles(req.files);
      throw new ValidationError('property data is required');
    }

    const files = req.files || [];
    if (files.length > 10) {
      cleanupTempFiles(files);
      throw new ValidationError('Too many files. Maximum 10 images are allowed in one request.');
    }

    const attachmentsToDelete = propertyData.attachmentsToDelete || [];
    const completeProperty = await propertyService.updatePropertyWithMediaService(
      propertyId,
      propertyData,
      createdBy,
      {
        files,
        attachmentsToDelete,
        uploadedBy: resolveActorId(req),
        sourcePortal: await resolvePropertySourcePortal(req.user),
      }
    );

    return res.json(completeProperty);
  } catch (e) {
    cleanupTempFiles(req.files);
    throw e;
  }
};

const deleteProperty = async (req, res) => {
  const propertyId = req.params && req.params.id;
  await propertyService.deletePropertyService(propertyId);
  res.json({ message: 'Property deleted successfully' });
};

const archiveProperty = async (req, res) => {
  const propertyId = req.params && req.params.id;
  const result = await propertyService.toggleArchivePropertyService(propertyId);
  res.json(result);
};

const addNoteToProperty = async (req, res) => {
  noteUpload.uploadArray(req, res, async function (err) {
    if (err) {
      throw new ValidationError(err.message || 'Upload failed');
    }
    try {
      const propertyId = req.params && req.params.id;
      const description = req.body && req.body.description;
      const files = req.files || [];
      if (!description) throw new ValidationError('description is required');
      if (files.length > 10) throw new ValidationError('Maximum 10 attachments allowed.');

      await assertUploadedFilesValid(files, 'NOTE_ATTACHMENT');
      const updated = await propertyService.addNoteToPropertyService(
        propertyId,
        description,
        files,
        resolveActorId(req)
      );

      const notesOnly = Array.isArray(updated && updated.notes) ? updated.notes : [];
      return res.status(201).json({ notes: notesOnly });
    } catch (e) {
      cleanupTempFiles(req.files);
      throw e;
    }
  });
};

const uploadImages = async (req, res) => {
  uploadArray(req, res, async function (err) {
    if (err) {
      throw new ValidationError(err.message || 'Upload failed');
    }
    try {
      const propertyId = (req.params && req.params.id) || req.query.propertyId;
      if (!propertyId) throw new ValidationError('propertyId is required as path param or query');

      const files = req.files || [];
      if (!files || files.length === 0) {
        throw new ValidationError('No files uploaded. Use form field "images" to upload one or more image files.');
      }
      if (files.length > 10) throw new ValidationError('Too many files. Maximum 10 images are allowed in one request.');

      await assertUploadedFilesValid(files, 'IMAGE');
      const savedImages = await propertyService.uploadPropertyImagesService(propertyId, files, {
        uploadedBy: resolveActorId(req),
      });
      return res.status(201).json({ savedImages });
    } catch (e) {
      cleanupTempFiles(req.files);
      throw e;
    }
  });
};

const exportPropertiesCsv = async (req, res) => {
  const q = Object.assign({}, req.query || {});
  if (typeof q.pagesize !== 'undefined' && typeof q.pageSize === 'undefined') q.pageSize = q.pagesize;
  if (typeof q.page !== 'undefined') q.page = Number(q.page);
  if (typeof q.pageSize !== 'undefined') q.pageSize = Number(q.pageSize);

  if (typeof q.page !== 'undefined' && (!Number.isInteger(q.page) || q.page <= 0)) {
    throw new ValidationError('page must be a positive integer and not zero');
  }
  if (typeof q.pageSize !== 'undefined' && (!Number.isInteger(q.pageSize) || q.pageSize <= 0)) {
    throw new ValidationError('pageSize must be a positive integer and not zero');
  }
  await applyLandlordPropertyQueryScope(req, q);

  const result = await propertyService.exportPropertiesCsvService(q);
  const filename = sanitizeFilename(result && result.filename ? result.filename : 'properties_export.csv');
  const csv = result && result.csv ? result.csv : '';

  res.setHeader('Content-Type', 'text/csv;charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csv);
};

const importPropertiesCsv = async (req, res) => {
  const createdBy = resolveCreatedBy(req.query || {}, resolveActorId(req));
  if (!createdBy) throw new ValidationError('createdBy is required');

  uploadFile(req, res, async function (err) {
    if (err) throw new ValidationError(err.message || 'Upload failed');

    try {
      const files = req.files || [];
      if (!files || files.length === 0) {
        throw new ValidationError('No file uploaded. Use form field "file" to upload CSV.');
      }

      await assertUploadedFilesValid(files, 'IMPORT');
      const result = await propertyService.importPropertiesFromCsv(files[0], createdBy, {
        sourcePortal: await resolvePropertySourcePortal(req.user),
      });
      cleanupTempFiles(files);
      return res.status(200).json(result);
    } catch (e) {
      cleanupTempFiles(req.files);
      throw e;
    }
  });
};

const exportProperties = async (req, res) => {
  const q = Object.assign({}, req.query || {});
  const format = q.format || 'csv';
  const includeArchived = q.includeArchived === 'true' || q.includeArchived === true;

  if (!includeArchived) {
    q.isArchived = false;
  }

  delete q.format;
  delete q.includeArchived;

  if (typeof q.pagesize !== 'undefined' && typeof q.pageSize === 'undefined') q.pageSize = q.pagesize;
  if (typeof q.page !== 'undefined') q.page = Number(q.page);
  if (typeof q.pageSize !== 'undefined') q.pageSize = Number(q.pageSize);
  await applyLandlordPropertyQueryScope(req, q);

  const result = await propertyExportService.exportProperties(q, format);
  const filename = sanitizeFilename(result && result.filename ? result.filename : `properties_export.${format}`);
  const content = result && result.content ? result.content : '';
  const contentType = safeContentType(result && result.contentType ? result.contentType : null, 'application/octet-stream');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (typeof content === 'string') {
    return res.send(content);
  }
  res.setHeader('Content-Length', content.length);
  return res.send(content);
};

const downloadPropertyTemplate = async (req, res) => {
  const format = (req.query && req.query.format) || 'csv';

  if (!['csv', 'xlsx', 'excel'].includes(format)) {
    throw new ValidationError('Invalid format. Supported formats: csv, xlsx, excel');
  }

  const result = await propertyExportService.generatePropertyTemplate(format);
  const filename = sanitizeFilename(result && result.filename ? result.filename : `property_template.${format === 'csv' ? 'csv' : 'xlsx'}`);
  const content = result && result.content ? result.content : '';
  const contentType = safeContentType(result && result.contentType ? result.contentType : null, 'text/csv');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (typeof content === 'string') {
    return res.send(content);
  }
  res.setHeader('Content-Length', content.length);
  return res.send(content);
};

const setProfileImage = async (req, res) => {
  const propertyId = req.params && req.params.id;
  const imageId = req.body && req.body.imageId;

  if (!propertyId) throw new ValidationError('propertyId is required');
  if (!imageId) throw new ValidationError('imageId is required in request body');

  const updated = await propertyService.setProfileImageService(propertyId, imageId);
  return res.json({ message: 'Profile image updated successfully', profileImageId: updated.profileImageId });
};

const deleteImages = async (req, res) => {
  const propertyId = req.params && req.params.id;
  const imageIds = req.body && req.body.imageIds;

  if (!propertyId) throw new ValidationError('propertyId is required');
  if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
    throw new ValidationError('imageIds array is required in request body');
  }

  const result = await propertyService.deletePropertyImagesService(propertyId, imageIds, {
    deletedBy: resolveActorId(req),
  });

  return res.json(result);
};

const propertySearchService = require('../service/propertySearch.service');

const searchProperties = async (req, res) => {
  try {
    const { text = '' } = req.query;
    const scope = await applyLandlordPropertyQueryScope(req, Object.assign({}, req.query || {}));
    const createdBy = scope.createdBy;
    const lite = req.query && (req.query.lite === true || String(req.query.lite).toLowerCase() === 'true');
    const limit = req.query && req.query.limit != null ? Number(req.query.limit) : undefined;

    if (!createdBy) {
      return responseHelper.error(res, 'createdBy is required', 400);
    }

    const result = await propertySearchService.searchPropertiesService(text, createdBy, {
      lite,
      limit,
      sourcePortal: scope.sourcePortal,
    });
    return responseHelper.success(res, result, 'Success', 200);
  } catch (err) {
    const status = err.status || 500;
    return responseHelper.error(res, err.message, status);
  }
};

const checkPropertyName = async (req, res) => {
  const scope = await applyLandlordPropertyQueryScope(req, Object.assign({}, req.query || {}));
  const result = await propertyService.checkPropertyNameAvailabilityService(
    req.query.name,
    scope.createdBy,
    req.query.excludePropertyId || null,
    scope.sourcePortal
  );
  return responseHelper.success(res, result, 'Success', 200);
};

const { wrapController } = require('../../../../../common/helpers/asyncHandler');

module.exports = wrapController({
  getPropertyById,
  getProperties,
  createProperty,
  updateProperty,
  deleteProperty,
  archiveProperty,
  addNoteToProperty,
  uploadImages,
  exportPropertiesCsv,
  importPropertiesCsv,
  exportProperties,
  downloadPropertyTemplate,
  setProfileImage,
  deleteImages,
  searchProperties,
  checkPropertyName,
});
