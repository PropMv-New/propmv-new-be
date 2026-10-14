/**
 * ------------------------------------------------------------------
 * File: uploadHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for uploadHelper.
 *
 * Used By:
 * expense.controller, invoice.routes, lease.controller, template.controller
 * ------------------------------------------------------------------
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');

/**
 * createUpload - factory to create multer middleware and tempDir for different upload contexts
 * @param {string} fieldName - form field name (e.g., 'images', 'documents')
 * @param {string} tempSubDir - subdirectory under uploads/ to store temporary files (e.g., 'property-images')
 * @param {object} opts - options: { maxCount, maxSizeBytes, filenameGenerator }
 */
function createUpload(fieldName, tempSubDir, opts = {}) {
  const maxCount = opts.maxCount || 10;
  const maxSizeBytes = opts.maxSizeBytes || (20 * 1024 * 1024);
  const config = require('../../config/default');
  const uploadBase = path.resolve(config.uploads && config.uploads.base ? String(config.uploads.base) : path.join(__dirname, '../../uploads'));
  const chosenSubdir = tempSubDir || opts.defaultSubdir || (config.uploads && config.uploads.propertySubdir);
  if (!chosenSubdir) throw new Error('uploadHelper: target subdirectory is not configured. Provide tempSubDir or set config.uploads.* in environment');
  const tempDir = path.resolve(path.join(uploadBase, chosenSubdir));
  if (!tempDir.startsWith(uploadBase + path.sep) && tempDir !== uploadBase) {
    throw new Error('uploadHelper: tempSubDir escapes the configured upload base directory');
  }
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, tempDir);
    },
    filename: function (req, file, cb) {
      try {
        const rawId = req.params.id || req.query.propertyId || req.query.tenantId || 'unknown';
        const safeId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const timestamp = Date.now();
        const rawExt = path.extname(file.originalname) || '';
        const safeExt = rawExt.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
        const generated = opts.filenameGenerator && opts.filenameGenerator(file, req);
        const candidate = generated
          ? String(generated).replace(/[^a-zA-Z0-9._-]/g, '_')
          : `${safeId}_${timestamp}${safeExt}`;
        const safe = path.basename(candidate);
        const resolvedFinal = path.resolve(path.join(tempDir, safe));
        if (!resolvedFinal.startsWith(tempDir + path.sep)) {
          return cb(new Error('uploadHelper: filename escapes the upload directory'));
        }
        cb(null, safe);
      } catch (e) {
        cb(e);
      }
    }
  });

  const multerOpts = { storage, limits: { fileSize: maxSizeBytes } };
  if (opts.fileFilter) multerOpts.fileFilter = opts.fileFilter;
  const upload = multer(multerOpts);
  return { 
    uploadArray: upload.array(fieldName, maxCount), 
    uploadSingle: upload.single(fieldName),
    tempDir 
  };
}

module.exports = { createUpload };
