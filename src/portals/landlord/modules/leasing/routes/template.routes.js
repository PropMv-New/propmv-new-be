/**
 * ------------------------------------------------------------------
 * File: template.routes.js
 * Module: Landlord Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * landlord
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const leaseController = require('../controller/lease.controller');
const { createUpload } = require('../../../../../common/helpers/uploadHelper');
const { multerPdfFilter } = require('../../../../../common/helpers/fileValidationHelper');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const { validateBody, validateParams, validateQuery } = require('../../../../../middleware/requestValidator');
const { 
  createdByParamSchema, 
  templateIdParamSchema, 
  updateParamsSchema, 
  createTemplateSchema, 
  updateTemplateSchema,
  getTemplatesQuerySchema
} = require('../validators/template.validator');

const { uploadArray: upload } = createUpload('template', 'lease-templates', {
  maxCount: 1,
  fileFilter: multerPdfFilter,
  maxSizeBytes: 10 * 1024 * 1024 // 10MB limit
});

// /api/v1/leasing/creator/:createdBy/templates
router.post('/creator/:createdBy/templates', 
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(createdByParamSchema),
  upload,
  validateBody(createTemplateSchema),
  leaseController.createTemplate
);

// /api/v1/leasing/creator/:createdBy/templates
router.get('/creator/:createdBy/templates', 
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(createdByParamSchema),
  validateQuery(getTemplatesQuerySchema),
  leaseController.getTemplatesByLandlord
);

// /api/v1/leasing/templates/:templateId
router.get('/templates/:templateId', 
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(templateIdParamSchema),
  leaseController.getTemplateById
);

// Download the template document
router.get('/templates/:templateId/download',
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(templateIdParamSchema),
  leaseController.downloadTemplate
);

// /api/v1/leasing/creator/:createdBy/templates/:templateId
router.put('/creator/:createdBy/templates/:templateId', 
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(updateParamsSchema),
  upload,
  validateBody(updateTemplateSchema),
  leaseController.updateTemplate
);

// /api/v1/leasing/creator/:createdBy/templates/:templateId
router.delete('/creator/:createdBy/templates/:templateId', 
  authMiddleware, authorize, lockCheckMiddleware,
  validateParams(updateParamsSchema),
  leaseController.deleteTemplate
);

module.exports = router;
