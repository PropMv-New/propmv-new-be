'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../../../../middleware/auth');
const requireAdministrator = require('../../../../middleware/requireAdministrator');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { validateQuery, validateParams } = require('../../../../middleware/requestValidator');
const controller = require('../controller/auditInvestigation.controller');
const {
  auditSearchQuerySchema,
  outboxFailedQuerySchema,
  outboxReplayParamsSchema,
  auditDetailParamsSchema,
} = require('../validators/auditInvestigation.validator');

const adminGuard = [authMiddleware, requireAdministrator];

router.get('/events', ...adminGuard, validateQuery(auditSearchQuerySchema), controller.searchAuditEvents);
router.get('/events/:id', ...adminGuard, validateParams(auditDetailParamsSchema), controller.getAuditEventDetail);

router.get('/outbox/metrics', ...adminGuard, controller.getOutboxDiagnostics);
router.get('/outbox/failed', ...adminGuard, validateQuery(outboxFailedQuerySchema), controller.listFailedOutbox);
router.get('/outbox/failed/:eventId', ...adminGuard, validateParams(outboxReplayParamsSchema), controller.getFailedOutboxDetail);
router.post('/outbox/failed/:eventId/replay', csrfProtection, ...adminGuard, validateParams(outboxReplayParamsSchema), controller.replayFailedOutbox);

module.exports = router;
