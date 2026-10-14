/**
 * ------------------------------------------------------------------
 * File: roles.routes.js
 * Module: Src Shared Modules Auth Routes
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * auth.routes
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const { listRoles, getRoleById, createRole, updateRole, deleteRole, listPermissions, getSignupRoles, listModules } = require('../controllers/roles.controller');

/**
 * require Admin
 *
 * Performs logic operations for requireAdmin.
 *
 * @param req - Request/input argument
 * @param res - Request/input argument
 * @param next - Request/input argument
 * @returns Operations result
 */
function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'Admin')) return res.status(403).json({ message: 'Admin only' });
  next();
}

const { validateBody, validateParams } = require('../../../../middleware/requestValidator');
const { createRoleSchema, updateRoleSchema, idParamSchema } = require('../validators/auth.validator');

// Signup roles endpoint - public access for signup form
router.get('/signup-roles', getSignupRoles);

// Roles endpoints under /api/auth/roles
router.get('/role', authMiddleware, authorize, lockCheckMiddleware, listRoles);
router.get('/role/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), getRoleById);
router.post('/role', authMiddleware, authorize, lockCheckMiddleware, validateBody(createRoleSchema), createRole);
router.put('/role/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(updateRoleSchema), updateRole);
router.delete('/role/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), deleteRole);

// Permissions (functions) list under /api/auth/permissions
router.get('/permissions', authMiddleware, authorize, lockCheckMiddleware, listPermissions);

// Modules list under /api/auth/modules
router.get('/modules', authMiddleware, authorize, lockCheckMiddleware, listModules);

module.exports = router;


