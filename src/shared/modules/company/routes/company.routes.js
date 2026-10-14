/**
 * ------------------------------------------------------------------
 * File: company.routes.js
 * Module: Company Module
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
const companyController = require('../controllers/company.controller');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { validateBody, validateParams } = require('../../../../middleware/requestValidator');
const {
  createCompanySchema,
  updateCompanySchema,
  addRoleSchema,
  updateRoleSchema,
  idParamSchema,
  roleIdParamSchema,
} = require('../validators/company.validator');

// Company CRUD routes
router.get('/', authMiddleware, authorize, lockCheckMiddleware, companyController.listCompanies);
router.get('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), companyController.getCompanyById);
router.post('/', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateBody(createCompanySchema), companyController.createCompany);
router.put('/:id', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(updateCompanySchema), companyController.updateCompany);
router.delete('/:id', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), companyController.deleteCompany);

// Company Roles routes
router.get('/:id/roles', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), companyController.getCompanyRoles);
router.get('/:id/roles/:roleId', authMiddleware, authorize, lockCheckMiddleware, validateParams(roleIdParamSchema), companyController.getCompanyRole);
router.post('/:id/roles', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(addRoleSchema), companyController.addRoleToCompany);
router.put('/:id/roles/:roleId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(roleIdParamSchema), validateBody(updateRoleSchema), companyController.updateRoleInCompany);
router.delete('/:id/roles/:roleId', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(roleIdParamSchema), companyController.deleteRoleFromCompany);

module.exports = router;
