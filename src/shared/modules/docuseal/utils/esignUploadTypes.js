/** Formats DocuSeal accepts for template upload: PDF, DOCX, XLSX, JPEG, PNG, ZIP. */
const ESIGN_UPLOAD_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.jpg', '.jpeg', '.png', '.zip'];

const ESIGN_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
];

const ESIGN_UPLOAD_LABEL = 'PDF, DOCX, XLSX, JPEG, PNG, or ZIP';
const ESIGN_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const ESIGN_UPLOAD_SIZE_LABEL = '20MB';

function getFileExtension(fileName = '') {
  const match = String(fileName).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : '';
}

function isDocxUpload(fileName = '', mimeType = '') {
  const ext = getFileExtension(fileName);
  const mime = String(mimeType || '').toLowerCase();
  return ext === '.docx' || mime.includes('wordprocessingml.document');
}

function isAllowedEsignUpload(fileName = '', mimeType = '') {
  const ext = getFileExtension(fileName);
  const mime = String(mimeType || '').toLowerCase();
  if (ESIGN_UPLOAD_EXTENSIONS.includes(ext)) return true;
  return ESIGN_UPLOAD_MIME_TYPES.some((allowed) => mime === allowed || mime.includes(allowed));
}

function stripEsignUploadExtension(fileName = '') {
  const stripped = String(fileName).replace(/\.(pdf|docx|xlsx|jpe?g|png|zip)$/i, '').trim();
  return stripped || 'Uploaded document';
}

function docusealTemplatePathForUpload(fileName = '', mimeType = '') {
  return isDocxUpload(fileName, mimeType) ? '/templates/docx' : '/templates/pdf';
}

module.exports = {
  ESIGN_UPLOAD_EXTENSIONS,
  ESIGN_UPLOAD_LABEL,
  ESIGN_UPLOAD_MAX_BYTES,
  ESIGN_UPLOAD_MIME_TYPES,
  ESIGN_UPLOAD_SIZE_LABEL,
  docusealTemplatePathForUpload,
  getFileExtension,
  isAllowedEsignUpload,
  isDocxUpload,
  stripEsignUploadExtension,
};
