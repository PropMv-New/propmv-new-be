/**
 * ------------------------------------------------------------------
 * File: event.routes.js
 * Module: Events Module
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
const csrfProtection = require('../../../../middleware/csrfProtection');
const controller = require('../controller/event.controller');
const { validateQuery, validateParams, validateBody } = require('../../../../middleware/requestValidator');
const { createEventSchema, updateEventSchema, idParamSchema, listQuerySchema } = require('../validators/event.validator');

const readGuard = [authMiddleware, authorize, lockCheckMiddleware];
const writeGuard = [csrfProtection, authMiddleware, authorize, lockCheckMiddleware];

router.post('/events', ...writeGuard, validateBody(createEventSchema), controller.createEvent);

router.get('/events', ...readGuard, validateQuery(listQuerySchema), controller.getEvents);

router.get('/events/:id', ...readGuard, validateParams(idParamSchema), controller.getEventById);

router.put('/events/:id', ...writeGuard, validateParams(idParamSchema), validateBody(updateEventSchema), controller.updateEvent);

router.delete('/events/:id', ...writeGuard, validateParams(idParamSchema), controller.deleteEvent);

module.exports = router;
