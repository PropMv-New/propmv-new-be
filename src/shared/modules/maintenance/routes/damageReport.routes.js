/**
 * ------------------------------------------------------------------
 * File: damageReport.routes.js
 * Module: Maintenance Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * routes
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../controller/damageReport.controller');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const { createUpload } = require('../../../../common/helpers/uploadHelper');
const { validateMultipart } = require('../../../../middleware/multipartValidator');
const { validateQuery } = require('../../../../middleware/requestValidator');
const { multerImageFilter } = require('../../../../common/helpers/fileValidationHelper');
const { createDamageReportSchema, updateDamageReportSchema, listDamageReportsSchema } = require('../validators/damageReport.validator');
const csrfProtection = require('../../../../middleware/csrfProtection');

const { uploadArray } = createUpload('files', 'damage-reports', {
  maxCount: 100,
  fileFilter: multerImageFilter,
  maxSizeBytes: 100 * 1024 * 1024,
});

router.post('/damage-report', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, uploadArray, validateMultipart(createDamageReportSchema, { fileFilter: multerImageFilter, contentProfile: 'IMAGE', parseJsonData: true }), controller.createDamageReport);

router.get('/damage-report', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listDamageReportsSchema), controller.listDamageReports);

router.get('/damage-report/:id', authMiddleware, authorize, lockCheckMiddleware, controller.getDamageReport);

router.put('/damage-report/:id', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, uploadArray, validateMultipart(updateDamageReportSchema, { fileFilter: multerImageFilter, contentProfile: 'IMAGE', parseJsonData: true }), controller.updateDamageReport);

router.delete('/damage-report/:id', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, controller.deleteDamageReport);

module.exports = router;
