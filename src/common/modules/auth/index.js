/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Src Common Modules Auth
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const createAuthController = require('./controllers/auth.controller');
const createAuthRoutes = require('./routes/auth.routes');
const authService = require('./services/auth.service');
const validators = require('./validators/auth.validator');
const messages = require('./messages/auth.messages');

module.exports = {
  createAuthController,
  createAuthRoutes,
  authService,
  validators,
  messages,
};
