/**
 * ------------------------------------------------------------------
 * File: lease.routes.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const leaseController = require('../controller/lease.controller');
const { validateBody, validateParams, validateQuery } = require('../../../../../common/middleware/requestValidator');
const { createLeaseSchema, updateLeaseSchema, idParamSchema, listLeasesQuerySchema, listByLandlordQuerySchema, getLeaseByTenantQuerySchema, renewLeaseSchema } = require('../validators/lease.validator');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');

// POST /api/v1/leasing/create-lease
router.post('/create-lease', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateBody(createLeaseSchema), leaseController.createLease);

// GET /api/v1/leasing/lease
router.get('/lease', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listLeasesQuerySchema), leaseController.listLeases);

// GET /api/v1/leasing/lease/landlord?landlordId=...&status=Active|InProcess|FutureLease|Expiring90|Expired|Terminated
router.get('/lease/list', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listByLandlordQuerySchema), leaseController.listLeasesByLandlord);

// GET /api/v1/leasing/lease/:id
router.get('/lease/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), leaseController.getLeaseById);

// PUT /api/v1/leasing/edit-lease/:id
router.put('/edit-lease/:id', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(updateLeaseSchema), leaseController.updateLease);

// DELETE /api/v1/leasing/lease/:id
router.delete('/lease/:id', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateParams(idParamSchema), leaseController.deleteLease);

// POST /api/v1/leasing/lease/:id/document
router.post('/lease/:id/document', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateParams(idParamSchema), leaseController.uploadDocument);

// PATCH /api/v1/leasing/lease/:id/terminate
router.patch('/lease/:id/terminate', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateParams(idParamSchema), leaseController.terminateLease);

// POST /api/v1/leasing/lease/:id/notes
router.post('/lease/:id/notes', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateParams(idParamSchema), leaseController.addNoteToLease);

// GET /api/v1/leasing/lease/tenant?tenantId=...&propertyId=...&unit=...
router.get('/lease/tenant', authMiddleware, authorize, lockCheckMiddleware, validateQuery(getLeaseByTenantQuerySchema), leaseController.getLeaseByTenant);

// POST /api/v1/leasing/renew-lease/:id
router.post('/renew-lease/:id', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(renewLeaseSchema), leaseController.renewLease);

module.exports = router;
