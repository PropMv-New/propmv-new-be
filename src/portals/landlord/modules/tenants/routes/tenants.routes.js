/**
 * ------------------------------------------------------------------
 * File: tenants.routes.js
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
const tenantController = require('../controller/tenant.controller');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../../middleware/lockCheck');
const { validateBody, validateQuery, validateParams } = require('../../../../../middleware/requestValidator');
const { createTenantSchema, updateTenantSchema, importTenantsQuerySchema, setupTenantSchema, updateSetupTenantSchema, idParamSchema, listTenantsQuerySchema, listTenantsWithDetailsQuerySchema, tenantDetailsQuerySchema } = require('../validators/tenant.validator');
const { resendInviteSchema } = require('../validators/tenant.validator');

// ========== SPECIFIC ROUTES (must come before :id routes) ==========

// /api/v1/tenants/setup - POST
router.post('/setup', authMiddleware, authorize, lockCheckMiddleware, validateBody(setupTenantSchema), tenantController.setupTenant);

// /api/v1/tenants/send-application - POST (NEW: Send screening application invitations)
router.post('/send-application', authMiddleware, authorize, lockCheckMiddleware, validateBody(setupTenantSchema), tenantController.sendApplicationInvitation);

// /api/v1/tenants/update-setup - PUT (NEW: for updating existing lease + tenants)
router.put('/update-setup', authMiddleware, authorize, lockCheckMiddleware, validateBody(updateSetupTenantSchema), tenantController.updateSetupTenant);

// /api/v1/tenants/setup/:id - PUT
router.put('/setup/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(setupTenantSchema), tenantController.updateTenantSetup);

// /api/v1/tenants/export-multi - GET
router.get('/export-multi', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listTenantsWithDetailsQuerySchema), tenantController.exportTenants);

// /api/v1/tenants/export - GET
router.get('/export', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listTenantsQuerySchema), tenantController.exportTenantsCsv);

// /api/v1/tenants/list-with-details - GET
router.get('/list-with-details', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listTenantsWithDetailsQuerySchema), tenantController.listTenantsWithDetails);

// /api/v1/tenants/names - GET
router.get('/names', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listTenantsQuerySchema), tenantController.getTenantNames);

// /api/v1/tenants/details - GET
router.get('/details', authMiddleware, authorize, lockCheckMiddleware, validateQuery(tenantDetailsQuerySchema), tenantController.getTenantDetails);

// /api/v1/tenants/import - POST
router.post('/import', authMiddleware, authorize, lockCheckMiddleware, validateQuery(importTenantsQuerySchema), tenantController.importTenantsCsv);

// /api/v1/tenants/resend-invite - POST
router.post('/resend-invite', authMiddleware, authorize, lockCheckMiddleware, validateBody(resendInviteSchema), tenantController.resendInvite);

// /api/v1/tenants/search/by-email - GET (search tenant by email)
router.get('/search/by-email', authMiddleware, authorize, lockCheckMiddleware, tenantController.getTenantByEmail);

// /api/v1/tenants/lease-onboarding-status/:leaseId - GET
router.get('/lease-onboarding-status/:leaseId', authMiddleware, authorize, lockCheckMiddleware, tenantController.getLeaseOnboardingStatus);

// /api/v1/tenants/resend-lease-communication - POST
router.post('/resend-lease-communication', authMiddleware, authorize, lockCheckMiddleware, tenantController.resendLeaseTenantCommunication);

// /api/v1/tenants/screening-context/:leaseId/:tenantId - GET
router.get('/screening-context/:leaseId/:tenantId', tenantController.getScreeningContext);

// ========== GENERIC ROUTES (must come after :id specific routes) ==========

// /api/v1/tenants - POST
router.post('/', authMiddleware, authorize, lockCheckMiddleware, validateBody(createTenantSchema), tenantController.createTenant);

// /api/v1/tenants - GET
router.get('/', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listTenantsQuerySchema), tenantController.listTenants);

// /api/v1/tenants/:id - PUT
router.put('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(updateTenantSchema), tenantController.updateTenant);

// /api/v1/tenants/:id - GET
router.get('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), tenantController.getTenantById);

// /api/v1/tenants/:id - DELETE
router.delete('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), tenantController.deleteTenant);

// /api/v1/tenants/:id/documents - POST
router.post('/:id/documents', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), tenantController.uploadDocuments);

// /api/v1/tenants/:id/archive - PATCH
router.patch('/:id/archive', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), tenantController.archiveTenant);

// /api/v1/tenants/:id/unarchive - PATCH
router.patch('/:id/unarchive', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), tenantController.unarchiveTenant);

module.exports = router;
