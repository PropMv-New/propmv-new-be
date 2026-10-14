/**
 * ------------------------------------------------------------------
 * File: documents.routes.js
 * Module: Documents Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../controller/documents.controller');
const hoaController = require('../controller/hoa.controller');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const { hoaDataIsolation } = require('../../../../middleware/hoaDataIsolation');
const { validateUploadedFiles } = require('../../../../middleware/multipartValidator');
const { multerInvoiceDocFilter } = require('../../../../common/helpers/fileValidationHelper');
const csrfProtection = require('../../../../middleware/csrfProtection');

/** authMiddleware must run before hoaDataIsolation so req.userId is populated. */
const withAuthAndHoaScope = [authMiddleware, authorize, hoaDataIsolation];

const hoaDocumentRouter = express.Router();

hoaDocumentRouter.get('/', ...withAuthAndHoaScope, hoaController.getHOADocuments);

hoaDocumentRouter.get('/by-owner/:ownerId', ...withAuthAndHoaScope, hoaController.getHOADocumentsForOwner);

hoaDocumentRouter.get('/:categoryId', ...withAuthAndHoaScope, hoaController.getHOADocumentsByCategory);

hoaDocumentRouter.post(
  '/upload',
  csrfProtection,
  ...withAuthAndHoaScope,
  hoaController.uploadSingle,
  validateUploadedFiles({ fileFilter: multerInvoiceDocFilter, contentProfile: 'INVOICE_DOC', minFiles: 1, maxFiles: 1 }),
  hoaController.uploadHOADocument
);

const optionalHoaDocumentFileUpload = (req, res, next) => {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('multipart/form-data')) {
    return next();
  }
  return hoaController.uploadSingle(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return next();
    return validateUploadedFiles({
      fileFilter: multerInvoiceDocFilter,
      contentProfile: 'INVOICE_DOC',
      minFiles: 1,
      maxFiles: 1,
    })(req, res, next);
  });
};

hoaDocumentRouter.patch(
  '/document/:documentId',
  csrfProtection,
  ...withAuthAndHoaScope,
  optionalHoaDocumentFileUpload,
  hoaController.updateHOADocument
);

hoaDocumentRouter.delete('/:documentId', csrfProtection, ...withAuthAndHoaScope, hoaController.deleteHOADocument);

router.use('/hoa', hoaDocumentRouter);

router.get('/:id', authMiddleware, authorize, hoaDataIsolation, controller.getMetadata);

router.get('/:id/url', authMiddleware, authorize, hoaDataIsolation, controller.getPresignedUrl);

router.get('/:id/download', authMiddleware, authorize, hoaDataIsolation, controller.download);

router.delete('/:id', csrfProtection, authMiddleware, authorize, hoaDataIsolation, controller.remove);

module.exports = router;
