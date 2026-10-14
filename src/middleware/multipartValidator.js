/**
 * ------------------------------------------------------------------
 * File: multipartValidator.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for multipartValidator.
 *
 * Used By:
 * invoice.routes, lease.controller, listing.routes, property.controller
 * ------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const { validateFilesContent } = require('../common/helpers/fileValidationHelper');

const _config = require('../config/default');
const UPLOAD_BASE_DIR = path.resolve(
  _config.uploads && _config.uploads.base ? String(_config.uploads.base) : path.join(__dirname, '../uploads')
);

function isSafeUploadPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  return resolved.startsWith(UPLOAD_BASE_DIR + path.sep) || resolved === UPLOAD_BASE_DIR;
}

/**
 * cleanup Uploaded Files
 *
 * Performs logic operations for cleanupUploadedFiles.
 *
 * @param files - Request/input argument
 * @returns Operations result
 */
function cleanupUploadedFiles(files) {
  if (!files || files.length === 0) return;
  for (const file of files) {
    try {
      if (file && file.path && isSafeUploadPath(file.path) && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    } catch (ignore) {
      /* ignore cleanup errors */
    }
  }
}

/**
 * validateMultipart: middleware factory for validating multipart form data + files
 * Supports two modes:
 * 1. Standard form-data: validates req.body fields against Joi schema
 * 2. JSON data mode: parses req.body.data (JSON string) and validates against Joi schema
 *
 * Files are optional - user may or may not upload files
 *
 * @param {object|null} schema - Joi schema for data validation (null if only validating files)
 * @param {object} opts - Options: { fileFilter, contentProfile, minFiles, maxFiles, parseJsonData }
 *   - fileFilter: multer file filter function (e.g., multerImageFilter, multerPdfFilter)
 *   - contentProfile: upload profile name for magic-byte validation (e.g., 'IMAGE', 'MAINTENANCE')
 *   - minFiles: minimum number of files required (default: 0)
 *   - maxFiles: maximum number of files allowed (default: Infinity)
 *   - parseJsonData: if true, parse req.body.data (JSON string) instead of req.body (default: false)
 */
function validateMultipart(schema, opts = {}) {
  return async (req, res, next) => {
    try {
      if (schema) {
        let dataToValidate = req.body || {};
        let rawItemIndices;
        if (opts.parseJsonData && req.body && Object.prototype.hasOwnProperty.call(req.body, 'itemIndices')) {
          rawItemIndices = req.body.itemIndices;
        }

        if (opts.parseJsonData && req.body.data) {
          try {
            const parsed = JSON.parse(req.body.data);
            if (parsed !== null && typeof parsed === 'object') {
              Object.keys(parsed).forEach((k) => {
                if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
                  delete parsed[k];
                }
              });
            }
            dataToValidate = parsed;
          } catch (parseErr) {
            return res.status(400).json({
              message: 'Validation failed',
              errors: [`Invalid JSON in data field: ${parseErr.message}`],
            });
          }
        }

        const { error: fieldError, value: validatedValue } = schema.validate(dataToValidate, {
          abortEarly: false,
          allowUnknown: false,
        });

        if (fieldError) {
          return res.status(400).json({
            message: 'Validation failed',
            errors: fieldError.details.map((d) => d.message),
          });
        }

        req.body = validatedValue;
        if (rawItemIndices !== undefined) {
          req.body.itemIndices = rawItemIndices;
        }
      }

      if (opts.fileFilter || opts.contentProfile) {
        let files = req.files || [];
        if (req.file) {
          files = [req.file];
        }

        const fileErrors = [];
        const emptyFiles = files.filter((f) => f && Number(f.size || 0) === 0);
        if (emptyFiles.length > 0) {
          emptyFiles.forEach((file, index) => {
            fileErrors.push(`File ${index + 1} (${file.originalname || 'unknown'}): Empty files are not allowed`);
          });
        }

        files = files.filter((f) => f && Number(f.size || 0) > 0);
        req.files = files;
        if (req.file && files.length === 1) {
          req.file = files[0];
        }

        if (opts.minFiles !== undefined && files.length < opts.minFiles) {
          fileErrors.push(`At least ${opts.minFiles} file(s) required`);
        }
        if (opts.maxFiles !== undefined && files.length > opts.maxFiles) {
          fileErrors.push(`Maximum ${opts.maxFiles} file(s) allowed`);
        }

        if (opts.fileFilter) {
          for (let i = 0; i < files.length; i += 1) {
            const file = files[i];
            opts.fileFilter(req, file, (err) => {
              if (err) {
                fileErrors.push(`File ${i + 1} (${file.originalname}): ${err.message}`);
              }
            });
          }
        }

        if (fileErrors.length === 0 && opts.contentProfile && files.length > 0) {
          const contentErrors = await validateFilesContent(files, opts.contentProfile);
          fileErrors.push(...contentErrors);
        }

        if (fileErrors.length > 0) {
          cleanupUploadedFiles(files);
          return res.status(400).json({
            message: 'File validation failed',
            errors: fileErrors,
          });
        }
      }

      return next();
    } catch (err) {
      cleanupUploadedFiles(req.files || (req.file ? [req.file] : []));
      return next(err);
    }
  };
}

/**
 * validate Uploaded Files
 *
 * Performs logic operations for validateUploadedFiles.
 *
 * @param opts - Request/input argument
 * @returns Operations result
 */
function validateUploadedFiles(opts = {}) {
  return validateMultipart(null, opts);
}

module.exports = {
  validateMultipart,
  validateUploadedFiles,
  cleanupUploadedFiles,
};
