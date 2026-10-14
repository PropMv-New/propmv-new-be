/**
 * ------------------------------------------------------------------
 * File: masterData.routes.js
 * Module: Src Shared Modules Master Routes
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
const masterDataController = require('../controller/masterData.controller');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const csrfProtection = require('../../../../middleware/csrfProtection');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const { validateBody, validateParams, validateQuery } = require('../../../../middleware/requestValidator');
const { masterCreateSchema, masterUpdateSchema, idParamSchema, keysQuerySchema } = require('../validators/master.validator');
const { listQuerySchema } = require('../validators/masterData.validator');

// /api/v1/master
router.post('/', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateBody(masterCreateSchema), masterDataController.createMasterData);

// /api/v1/master/keys
router.get('/keys', authMiddleware, authorize, lockCheckMiddleware, validateQuery(keysQuerySchema), masterDataController.getMasterData);

// /api/v1/master
router.get('/', authMiddleware, authorize, lockCheckMiddleware, validateQuery(listQuerySchema), masterDataController.listMasterData);

// /api/v1/master/:id
router.get('/:id', authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), masterDataController.getMasterDataById);

// /api/v1/master/:id
router.put('/:id', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), validateBody(masterUpdateSchema), masterDataController.updateMasterData);

// /api/v1/master/:id
router.delete('/:id', csrfProtection, authMiddleware, authorize, lockCheckMiddleware, validateParams(idParamSchema), masterDataController.deleteMasterData);

module.exports = router;
