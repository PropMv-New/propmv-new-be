/**
 * ------------------------------------------------------------------
 * File: maintenance.routes.js
 * Module: Maintenance Module
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * hoa-board, landlord, routes
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const controller = require('../controller/maintenance.controller');
const { validateParams, validateQuery, validateBody } = require('../../../../middleware/requestValidator');
const { validateMultipart } = require('../../../../middleware/multipartValidator');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { idParamSchema, listQuerySchema, createRequestSchema, updateRequestSchema, addCommentSchema, addNoteSchema, updateNoteSchema, noteIdParamSchema, exportQuerySchema } = require('../validators/maintenance.validator');
const Joi = require('joi');
const { createUpload } = require('../../../../common/helpers/uploadHelper');
const { multerMaintenanceDocFilter } = require('../../../../common/helpers/fileValidationHelper');

const assignVendorSchema = Joi.object({ vendorId: Joi.string().required() });

// Multer middleware for maintenance documents: parse files before validation
const { uploadArray: maintenanceUpload } = createUpload('documents', 'maintenance-attachments', {
	maxCount: 5,
	fileFilter: multerMaintenanceDocFilter,
	maxSizeBytes: 50 * 1024 * 1024
});

const guard = [csrfProtection, authMiddleware, authorize, lockCheckMiddleware];

// POST /api/v1/maintenance/request (accepts multipart/form-data with JSON data string)
router.post('/request',
  ...guard,
  maintenanceUpload,
  validateMultipart(createRequestSchema, { fileFilter: multerMaintenanceDocFilter, contentProfile: 'MAINTENANCE', parseJsonData: true }),
  controller.createRequest
);

// GET /api/v1/maintenance/request (must come before any parameterized routes)
router.get('/request', ...guard, validateQuery(listQuerySchema), controller.listRequests);

// GET /api/v1/maintenance/request/export - MUST be before /:id route
router.get('/request/export', ...guard, validateQuery(exportQuerySchema), controller.exportMaintenance);

// GET /api/v1/maintenance/active-tenants?property_id=...&unitName=...
router.get('/active-tenants', ...guard, controller.getActiveTenantsByProperty);

// GET /api/v1/maintenance/request/:id
router.get('/request/:id', ...guard, validateParams(idParamSchema), controller.getRequest);

// PUT /api/v1/maintenance/request/:id (accepts multipart/form-data with JSON data string)
router.put('/request/:id',
  ...guard,
  validateParams(idParamSchema),
  maintenanceUpload,
  validateMultipart(updateRequestSchema, { fileFilter: multerMaintenanceDocFilter, contentProfile: 'MAINTENANCE', parseJsonData: true }),
  controller.updateRequest
);

// DELETE /api/v1/maintenance/request/:id
router.delete('/request/:id', ...guard, validateParams(idParamSchema), controller.deleteRequest);

// PATCH /api/v1/maintenance/request/:id/resolve
router.patch('/request/:id/resolve', ...guard, validateParams(idParamSchema), controller.resolveRequest);

// PATCH /api/v1/maintenance/request/:id/reject
router.patch('/request/:id/reject', ...guard, validateParams(idParamSchema), controller.rejectRequest);

// POST /api/v1/maintenance/request/:id/comments (add a comment)
router.post('/request/:id/comments', ...guard, validateParams(idParamSchema), validateBody(addCommentSchema), controller.addComment);

// GET /api/v1/maintenance/request/:id/comments (get all comments)
router.get('/request/:id/comments', ...guard, validateParams(idParamSchema), controller.getComments);

// POST /api/v1/maintenance/request/:id/notes (add a note)
router.post('/request/:id/notes', ...guard, validateParams(idParamSchema), validateBody(addNoteSchema), controller.addNote);

// PUT /api/v1/maintenance/request/:id/notes/:noteId (update own note)
router.put('/request/:id/notes/:noteId', ...guard, validateParams(noteIdParamSchema), validateBody(updateNoteSchema), controller.updateNote);

// DELETE /api/v1/maintenance/request/:id/notes/:noteId (delete own note)
router.delete('/request/:id/notes/:noteId', ...guard, validateParams(noteIdParamSchema), controller.deleteNote);

// GET /api/v1/maintenance/request/:id/documents (get all documents for a maintenance request)
router.get('/request/:id/documents', ...guard, validateParams(idParamSchema), controller.getDocuments);

// POST /api/v1/maintenance/request/:id/documents (upload documents)
router.post('/request/:id/documents',
  ...guard,
  validateParams(idParamSchema),
  maintenanceUpload,
  validateMultipart(null, { fileFilter: multerMaintenanceDocFilter, contentProfile: 'MAINTENANCE' }),
  controller.uploadDocuments
);

// GET /api/v1/maintenance/request/:id/documents/:metadataId (download a specific document)
router.get('/request/:id/documents/:metadataId', ...guard, controller.downloadDocument);

// PATCH /api/v1/maintenance/request/:id/assign-vendor
router.patch('/request/:id/assign-vendor', ...guard, validateParams(idParamSchema), validateBody(assignVendorSchema), controller.assignVendor);

module.exports = router;



