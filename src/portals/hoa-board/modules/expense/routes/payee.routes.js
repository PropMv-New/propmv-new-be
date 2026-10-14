/**
 * ------------------------------------------------------------------
 * File: payee.routes.js
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
const controller = require('../controller/payee.controller');
const { validateBody, validateQuery, validateParams } = require('../../../../../common/middleware/requestValidator');
const authMiddleware = require('../../../../../middleware/auth');
const authorize = require('../../../../../middleware/authorize');
const csrfProtection = require('../../../../../middleware/csrfProtection');
const { idParamSchema, createPayeeSchema, updatePayeeSchema, listQuerySchema } = require('../validators/payee.validator');

router.post('/', authMiddleware, csrfProtection, authorize, validateBody(createPayeeSchema), controller.createPayee);
router.get('/', authMiddleware, authorize, validateQuery(listQuerySchema), controller.listPayees);
router.get('/:id', authMiddleware, authorize, validateParams(idParamSchema), controller.getPayee);
router.put('/:id', authMiddleware, csrfProtection, authorize, validateParams(idParamSchema), validateBody(updatePayeeSchema), controller.updatePayee);
router.delete('/:id', authMiddleware, csrfProtection, authorize, validateParams(idParamSchema), controller.deletePayee);

module.exports = router;
