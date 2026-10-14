'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../../../middleware/auth');
const requireAdministrator = require('../../../middleware/requireAdministrator');
const csrfProtection = require('../../../middleware/csrfProtection');
const { validateQuery, validateParams } = require('../../../middleware/requestValidator');
const controller = require('../controller/jobMonitoring.controller');
const { jobListQuerySchema, jobIdParamsSchema } = require('../validators/jobMonitoring.validator');

const adminGuard = [authMiddleware, requireAdministrator];

router.get('/metrics', ...adminGuard, controller.getMetrics);
router.get('/', ...adminGuard, validateQuery(jobListQuerySchema), controller.listBackgroundJobs);
router.get('/:jobId', ...adminGuard, validateParams(jobIdParamsSchema), controller.getBackgroundJob);
router.post('/:jobId/retry', csrfProtection, ...adminGuard, validateParams(jobIdParamsSchema), controller.retryBackgroundJob);

module.exports = router;
