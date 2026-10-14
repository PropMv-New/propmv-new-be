/**
 * ------------------------------------------------------------------
 * File: application.routes.js
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
const applicationController = require('../controller/application.controller');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const { validateBody, validateParams, validateQuery } = require('../../../../../middleware/requestValidator');
const { createApplicationSchema, updateApplicationSchema, idParamSchema, listQuerySchema, exportQuerySchema, createBlankApplicationSchema, leaseInviteAckSchema, requestApplicationSchema, submitApplicationWithCreatedBySchema } = require('../validators/application.validator');

const guard = [csrfProtection, authMiddleware, authorize, lockCheckMiddleware];

// /api/v1/application
router.post('/', ...guard, validateBody(createApplicationSchema), applicationController.createApplication);

// Submit screening application (public - no auth required for tenant submission)
// Supports two patterns:
// 1. /submit/:leaseId/:tenantId (from lease creation flow)
// 2. /submit (with createdBy in body, from request application flow)
router.post('/submit/:leaseId/:tenantId', validateBody(createApplicationSchema), applicationController.submitScreeningApplication);
router.post('/submit', validateBody(submitApplicationWithCreatedBySchema), applicationController.submitScreeningApplication);

// Create blank application for tenant (when they accept invitation)
router.post('/tenant/blank', validateBody(createBlankApplicationSchema), applicationController.createBlankApplicationForTenant);

// Public: tenant acknowledges lease invite (deep link; no auth)
router.post('/lease-invite-ack', validateBody(leaseInviteAckSchema), applicationController.acknowledgeLeaseInvitePublic);

// List applications (simple filters + pagination)
router.get('/', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), applicationController.listApplications);

// Export applications - New multi-format export endpoint
router.get('/export', authMiddleware, authorize, lockCheckMiddleware, validateQuery(exportQuerySchema), applicationController.exportApplications);

// Get applicant names for filter dropdown
router.get('/names', authMiddleware, authorize, lockCheckMiddleware, applicationController.getApplicantNames);

// Lease screening summary for application detail (multi-tenant lease status)
router.get(
  '/:id/lease-screening-summary',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  applicationController.getLeaseScreeningSummary
);

// Get single application
router.get('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), applicationController.getApplicationById);

// Update application
router.put('/:id', ...guard, validateParams(idParamSchema), validateBody(updateApplicationSchema), applicationController.updateApplication);

// Delete (soft)
router.delete('/:id', ...guard, validateParams(idParamSchema), applicationController.deleteApplication);

// Approve application by ID
router.post('/:id/approve', ...guard, validateParams(idParamSchema), applicationController.approveApplication);

// Reject application by ID
router.post('/:id/reject', ...guard, validateParams(idParamSchema), applicationController.rejectApplication);

// Update screening information
router.patch('/:id/screening', ...guard, validateParams(idParamSchema), applicationController.updateScreeningInfo);

// Add note to application
router.post('/:id/notes', ...guard, validateParams(idParamSchema), applicationController.addNote);

// Share application via email
router.post('/:id/share-email', ...guard, validateParams(idParamSchema), applicationController.shareApplicationViaEmail);

// Share application via URL
router.post('/:id/share-url', ...guard, validateParams(idParamSchema), applicationController.shareApplicationViaUrl);

// Request application from prospective tenant (send screening email)
router.post('/request', ...guard, validateBody(requestApplicationSchema), applicationController.requestApplication);

module.exports = router;
