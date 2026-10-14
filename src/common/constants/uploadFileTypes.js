/**
 * ------------------------------------------------------------------
 * File: uploadFileTypes.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Backend utility/module providing helper functions for uploadFileTypes.
 *
 * Used By:
 * fileContentValidation, fileMetadataValidation, fileValidationHelper
 * ------------------------------------------------------------------
 */

/**
 * Canonical upload file-type profiles shared across backend validation layers.
 * Keep in sync with innago-inspired-refresh/src/shared/utils/fileValidation/uploadFileTypes.ts
 */

const UPLOAD_FILE_PROFILES = {
  IMAGE: {
    extensions: ['.jpg', '.jpeg', '.png'],
    mimeTypes: ['image/jpeg', 'image/png'],
    maxSizeBytes: Number(process.env.UPLOAD_MAX_SIZE_IMAGE_BYTES || 10 * 1024 * 1024),
    errorMessage: 'Only image files (JPG, JPEG, PNG) are allowed',
  },
  VIDEO: {
    extensions: ['.mp4', '.mov', '.avi'],
    mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo'],
    maxSizeBytes: Number(process.env.UPLOAD_MAX_SIZE_VIDEO_BYTES || 100 * 1024 * 1024),
    errorMessage: 'Only video files (MP4, MOV, AVI) are allowed',
  },
  NOTE_ATTACHMENT: {
    extensions: ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls'],
    mimeTypes: [
      'image/jpeg',
      'image/png',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    maxSizeBytes: Number(process.env.UPLOAD_MAX_SIZE_NOTE_ATTACHMENT_BYTES || 20 * 1024 * 1024),
    errorMessage:
      'Only files with extensions (.jpg, .jpeg, .png, .pdf, .doc, .docx, .txt, .xlsx, .xls) are allowed',
  },
  MAINTENANCE: {
    extensions: ['.jpg', '.jpeg', '.png', '.3gp', '.mp4', '.m4v', '.mpeg', '.mov', '.webm', '.avi', '.pdf'],
    mimeTypes: [
      'image/jpeg',
      'image/png',
      'video/3gpp',
      'video/mp4',
      'video/x-m4v',
      'video/mpeg',
      'video/quicktime',
      'video/webm',
      'video/x-msvideo',
      'application/pdf',
    ],
    maxSizeBytes: Number(process.env.UPLOAD_MAX_SIZE_MAINTENANCE_BYTES || 100 * 1024 * 1024),
    errorMessage:
      'Only JPG, JPEG, PNG, PDF files and video files (3GP, MP4, M4V, MPEG, MOV, WEBM, AVI) are allowed.',
  },
  INVOICE_DOC: {
    extensions: ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls'],
    mimeTypes: [
      'image/jpeg',
      'image/png',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    maxSizeBytes: Number(process.env.UPLOAD_MAX_SIZE_INVOICE_DOC_BYTES || 20 * 1024 * 1024),
    errorMessage:
      'Only files with extensions (.jpg, .jpeg, .png, .pdf, .doc, .docx, .txt, .xlsx, .xls) are allowed',
  },
  PDF: {
    extensions: ['.pdf'],
    mimeTypes: ['application/pdf'],
    maxSizeBytes: Number(process.env.UPLOAD_MAX_SIZE_PDF_BYTES || 25 * 1024 * 1024),
    errorMessage: 'Only PDF files are allowed',
  },
  IMPORT: {
    extensions: ['.csv', '.xlsx', '.xls', '.json'],
    mimeTypes: [
      'text/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/json',
    ],
    maxSizeBytes: Number(process.env.UPLOAD_MAX_SIZE_IMPORT_BYTES || 15 * 1024 * 1024),
    errorMessage: 'Only CSV, XLS, XLSX, and JSON import files are allowed',
  },
};

const EXTENSION_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.3gp': 'video/3gpp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mpeg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

const MIME_TO_EXTENSIONS = Object.entries(EXTENSION_TO_MIME).reduce((acc, [ext, mime]) => {
  if (!acc[mime]) acc[mime] = [];
  acc[mime].push(ext);
  return acc;
}, {});

/**
 * get Profile
 *
 * Performs logic operations for getProfile.
 *
 * @param name - Request/input argument
 * @returns Operations result
 */
function getProfile(name) {
  const profile = UPLOAD_FILE_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown upload file profile: ${name}`);
  }
  return profile;
}

/**
 * get Accept String
 *
 * Performs logic operations for getAcceptString.
 *
 * @param profileName - Request/input argument
 * @returns Operations result
 */
function getAcceptString(profileName) {
  const profile = getProfile(profileName);
  return profile.extensions.join(',');
}

module.exports = {
  UPLOAD_FILE_PROFILES,
  EXTENSION_TO_MIME,
  MIME_TO_EXTENSIONS,
  getProfile,
  getAcceptString,
};
