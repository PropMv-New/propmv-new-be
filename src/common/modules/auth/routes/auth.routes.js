/**
 * ------------------------------------------------------------------
 * File: auth.routes.js
 * Module: Src Common Modules Auth Routes
 *
 * Purpose:
 * API router defining endpoints, HTTP methods, authorization middleware, and calling controllers.
 *
 * Used By:
 * auth
 * ------------------------------------------------------------------
 */

const express = require('express');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const csrfProtection = require('../../../../middleware/csrfProtection');
const { validateBody, validateQuery } = require('../../../../../middleware/requestValidator');
const {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  lockAccountSchema,
  unlockAccountSchema,
  refreshTokenSchema,
  sendMfaOtpSchema,
  verifyMfaOtpSchema
} = require('../validators/auth.validator');

/**
 * create Auth Routes
 *
 * Performs logic operations for createAuthRoutes.
 *
 * @param authController - Request/input argument
 * @returns Operations result
 */
function createAuthRoutes(authController) {
  const router = express.Router();

  router.post('/signup', csrfProtection, validateBody(signupSchema), authController.signup);
  router.post('/login', csrfProtection, validateBody(loginSchema), authController.login);
  router.post('/forgot-password', csrfProtection, validateBody(forgotPasswordSchema), authController.forgotPassword);
  router.put('/verify-otp-reset-password', csrfProtection, validateBody(verifyOtpSchema), authController.verifyOtpAndResetPassword);
  router.post('/send-mfa-otp', csrfProtection, validateBody(sendMfaOtpSchema), authController.sendMfaOtp);
  router.post('/verify-mfa-otp', csrfProtection, validateBody(verifyMfaOtpSchema), authController.verifyMfaOtp);
  // GET /refresh-token removed - GET requests with sensitive side-effects are CSRF-vulnerable (CWE-352).
  router.post('/refresh', csrfProtection, validateBody(refreshTokenSchema), authController.refreshToken);
  router.post('/logout', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, authController.logout);
  router.put('/lock-account', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateBody(lockAccountSchema), authController.lockAccount);
  router.put('/unlock-account', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateBody(unlockAccountSchema), authController.unlockAccount);
  router.get('/session', authMiddleware, authorize, lockCheckMiddleware, authController.getSession);
  router.put('/reset-password', authMiddleware, csrfProtection, authorize, lockCheckMiddleware, validateBody(resetPasswordSchema), authController.resetPassword);

  return router;
}

module.exports = createAuthRoutes;
