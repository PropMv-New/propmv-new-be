/**
 * ------------------------------------------------------------------
 * File: weather.routes.js
 * Module: Users Module
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
const weatherController = require('../controllers/weather.controller');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');

// GET /api/v1/users/weather?address=...
router.get('/weather', authMiddleware, authorize, lockCheckMiddleware, weatherController.getWeather);

module.exports = router;