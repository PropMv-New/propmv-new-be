const { getProfile } = require('../../../../common/constants/uploadFileTypes');

/** Max combined size for HOA document uploads in a single request (default 20MB). */
const HOA_DOCUMENT_MAX_TOTAL_BYTES = Number(
  process.env.HOA_DOCUMENT_MAX_TOTAL_BYTES || 20 * 1024 * 1024,
);

function getTotalFileSizeBytes(files) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  return list.reduce((sum, file) => sum + (file?.size || 0), 0);
}

/**
 * Validates HOA document upload size: each file within profile limit and total <= HOA cap.
 * @param {Array|object} files - Multer file(s)
 * @param {{ maxTotalBytes?: number, profileName?: string }} [options]
 */
function assertHoaDocumentUploadSize(files, options = {}) {
  const maxTotalBytes = options.maxTotalBytes ?? HOA_DOCUMENT_MAX_TOTAL_BYTES;
  const profile = getProfile(options.profileName || 'INVOICE_DOC');
  const perFileMax = profile.maxSizeBytes ?? maxTotalBytes;
  const list = Array.isArray(files) ? files : files ? [files] : [];

  if (list.length === 0) return;

  for (const file of list) {
    const size = file?.size || 0;
    const name = file?.originalname || file?.filename || 'file';
    if (size > perFileMax) {
      const err = new Error(`"${name}" exceeds the ${Math.round(perFileMax / 1024 / 1024)}MB file size limit`);
      err.status = 400;
      throw err;
    }
  }

  const total = getTotalFileSizeBytes(list);
  if (total > maxTotalBytes) {
    const err = new Error(
      `Total document size exceeds the ${Math.round(maxTotalBytes / 1024 / 1024)}MB limit`,
    );
    err.status = 400;
    throw err;
  }
}

module.exports = {
  HOA_DOCUMENT_MAX_TOTAL_BYTES,
  getTotalFileSizeBytes,
  assertHoaDocumentUploadSize,
};
