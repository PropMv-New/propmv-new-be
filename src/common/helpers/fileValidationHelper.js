/**
 * ------------------------------------------------------------------
 * File: fileValidationHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for fileValidationHelper.
 *
 * Used By:
 * multipartValidator, expense.controller, expense.routes, invoice.routes
 * ------------------------------------------------------------------
 */

const path = require('path');
const { getProfile } = require('../constants/uploadFileTypes');
const { validateUploadedFileContent } = require('./fileContentValidation');
const { validateFileMetadata } = require('./fileMetadataValidation');

/**
 * create Validation Error
 *
 * Performs logic operations for createValidationError.
 *
 * @param message - Request/input argument
 * @returns Operations result
 */
function createValidationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * matches Profile Metadata
 *
 * Performs logic operations for matchesProfileMetadata.
 *
 * @param file - Request/input argument
 * @param profileName - Request/input argument
 * @returns Operations result
 */
function matchesProfileMetadata(file, profileName) {
  if (!file) return false;
  const profile = getProfile(profileName);
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  return profile.extensions.includes(ext) && profile.mimeTypes.includes(mime);
}

/**
 * create Multer Filter
 *
 * Performs logic operations for createMulterFilter.
 *
 * @param profileName - Request/input argument
 * @returns Operations result
 */
function createMulterFilter(profileName) {
  const profile = getProfile(profileName);
  return function multerProfileFilter(req, file, cb) {
    if (!file) {
      return cb(createValidationError('No file provided'));
    }
    if (matchesProfileMetadata(file, profileName)) {
      return cb(null, true);
    }
    return cb(createValidationError(profile.errorMessage));
  };
}

const multerImageFilter = createMulterFilter('IMAGE');
const multerPdfFilter = createMulterFilter('PDF');
const multerMaintenanceDocFilter = createMulterFilter('MAINTENANCE');
const multerInvoiceDocFilter = createMulterFilter('INVOICE_DOC');
const multerNoteAttachmentFilter = createMulterFilter('NOTE_ATTACHMENT');
const multerImportFileFilter = createMulterFilter('IMPORT');

/**
 * is Allowed Image
 *
 * Performs logic operations for isAllowedImage.
 *
 * @param file - Request/input argument
 * @returns Operations result
 */
function isAllowedImage(file) {
  return matchesProfileMetadata(file, 'IMAGE');
}

/**
 * is Allowed Video
 *
 * Performs logic operations for isAllowedVideo.
 *
 * @param file - Request/input argument
 * @returns Operations result
 */
function isAllowedVideo(file) {
  if (!file) return false;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const profile = getProfile('MAINTENANCE');
  const videoExts = profile.extensions.filter((item) => item !== '.jpg' && item !== '.jpeg' && item !== '.png' && item !== '.pdf');
  const videoMimes = profile.mimeTypes.filter((item) => !item.startsWith('image/') && item !== 'application/pdf');
  return videoExts.includes(ext) && videoMimes.includes(mime);
}

/**
 * is Allowed Pdf
 *
 * Performs logic operations for isAllowedPdf.
 *
 * @param file - Request/input argument
 * @returns Operations result
 */
function isAllowedPdf(file) {
  return matchesProfileMetadata(file, 'PDF');
}

/**
 * is Allowed Invoice Doc
 *
 * Performs logic operations for isAllowedInvoiceDoc.
 *
 * @param file - Request/input argument
 * @returns Operations result
 */
function isAllowedInvoiceDoc(file) {
  return matchesProfileMetadata(file, 'INVOICE_DOC');
}

async function validateFilesContent(files, profileName) {
  const errors = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const label = file.originalname || file.filename || `file ${i + 1}`;

    const metadataResult = validateFileMetadata(file, profileName);
    if (!metadataResult.valid) {
      errors.push(`File ${i + 1} (${label}): ${metadataResult.reason}`);
      continue;
    }

    const contentResult = await validateUploadedFileContent(file);
    if (!contentResult.valid) {
      errors.push(`File ${i + 1} (${label}): ${contentResult.reason}`);
    }
  }

  return errors;
}

async function assertUploadedFilesValid(files, profileName) {
  const normalizedFiles = (files || []).filter((file) => file);
  const errors = [];

  if (normalizedFiles.length === 0) {
    return normalizedFiles;
  }

  errors.push(...(await validateFilesContent(normalizedFiles, profileName)));

  if (errors.length > 0) {
    const err = createValidationError(errors.join('; '));
    err.errors = errors;
    throw err;
  }

  return normalizedFiles.filter((file) => Number(file.size || 0) > 0);
}

const maintenanceProfile = getProfile('MAINTENANCE');
const invoiceProfile = getProfile('INVOICE_DOC');
const imageProfile = getProfile('IMAGE');

module.exports = {
  createMulterFilter,
  matchesProfileMetadata,
  isAllowedImage,
  isAllowedVideo,
  isAllowedPdf,
  isAllowedInvoiceDoc,
  multerImageFilter,
  multerVideoFilter: createMulterFilter('VIDEO'),
  multerPdfFilter,
  multerMaintenanceDocFilter,
  multerInvoiceDocFilter,
  multerNoteAttachmentFilter,
  multerImportFileFilter,
  validateFilesContent,
  assertUploadedFilesValid,
  ALLOWED_IMAGE_EXT: imageProfile.extensions,
  ALLOWED_IMAGE_MIME: imageProfile.mimeTypes,
  ALLOWED_VIDEO_EXT: maintenanceProfile.extensions.filter((ext) => ['.mp4', '.mov', '.avi'].includes(ext)),
  ALLOWED_VIDEO_MIME: maintenanceProfile.mimeTypes.filter((mime) => mime.startsWith('video/')),
  ALLOWED_MAINTENANCE_VIDEO_EXT: maintenanceProfile.extensions.filter((ext) => !['.jpg', '.jpeg', '.png', '.pdf'].includes(ext)),
  ALLOWED_MAINTENANCE_VIDEO_MIME: maintenanceProfile.mimeTypes.filter((mime) => mime.startsWith('video/')),
  ALLOWED_MAINTENANCE_IMAGE_EXT: imageProfile.extensions,
  ALLOWED_MAINTENANCE_IMAGE_MIME: imageProfile.mimeTypes,
  ALLOWED_MAINTENANCE_PDF_EXT: ['.pdf'],
  ALLOWED_MAINTENANCE_PDF_MIME: ['application/pdf'],
  MAINTENANCE_UPLOAD_ERROR_MESSAGE: maintenanceProfile.errorMessage,
  ALLOWED_INVOICE_DOC_EXT: invoiceProfile.extensions,
  ALLOWED_INVOICE_DOC_MIME: invoiceProfile.mimeTypes,
};
