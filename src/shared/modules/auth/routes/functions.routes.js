/**
 * ------------------------------------------------------------------
 * File: functions.routes.js
 * Module: Src Shared Modules Auth Routes
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
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const { listFunctions, getFunctionById, createFunction, updateFunction, deleteFunction } = require('../controllers/functions.controller');

// Admin-only middleware
function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'Admin')) return res.status(403).json({ message: 'Admin only' });
  next();
}

const { validateBody, validateParams } = require('../../../../middleware/requestValidator');
const { createFunctionSchema, updateFunctionSchema, idParamSchema } = require('../validators/auth.validator');

// Functions CRUD endpoints under /api/auth/functions
// GET /api/auth/functions - List all functions
router.get('/function', authMiddleware, authorize, lockCheckMiddleware, listFunctions);

// GET /api/auth/functions/:id - Get function by ID
router.get('/function/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), getFunctionById);

// POST /api/auth/functions - Create new function (admin only)
router.post('/function', authMiddleware, authorize, lockCheckMiddleware, validateBody(createFunctionSchema), createFunction);

// PUT /api/auth/functions/:id - Update function (admin only)
router.put('/function/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(updateFunctionSchema), updateFunction);

// DELETE /api/auth/functions/:id - Delete function (admin only)
router.delete('/function/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), deleteFunction);

module.exports = router;
