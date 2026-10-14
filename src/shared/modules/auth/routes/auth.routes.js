/**
 * ------------------------------------------------------------------
 * File: auth.routes.js
 * Module: Src Shared Modules Auth Routes
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
const authController = require('../controllers/auth.controller');
const authMiddleware = require('../../../../middleware/auth');
const authorize = require('../../../../middleware/authorize');
const lockCheckMiddleware = require('../../../../middleware/lockCheck');
const { validateBody, validateParams, validateQuery } = require('../../../../middleware/requestValidator');
const {
  signupSchema,
  checkIdentityQuerySchema,
  loginSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  verifyResetOtpSchema,
  resetPasswordSchema,
  lockAccountSchema,
  unlockAccountSchema,
  refreshTokenSchema,
  sendMfaOtpSchema,
  verifyMfaOtpSchema,
  renameTrustedDeviceSchema,
  idParamSchema,
  portalInviteValidateQuerySchema,
  portalInviteCompleteSchema,
} = require('../validators/auth.validator');
const portalInvitationController = require('../controllers/portalInvitation.controller');

// Import roles routes
const rolesRouter = require('./roles.routes');

// Public routes are intentionally available before a session exists so signup and account recovery can start anonymously.

// GET /api/v1/auth/config - public; exposes non-sensitive runtime config (e.g. trustedDeviceDays)
router.get('/config', authController.getAuthConfig);

// GET /api/v1/auth/check-identity?email=&phone=
router.get('/check-identity', validateQuery(checkIdentityQuerySchema), authController.checkIdentity);

// POST /api/v1/auth/signup
router.post('/signup', validateBody(signupSchema), authController.signup);

// POST /api/v1/auth/login
router.post('/login', validateBody(loginSchema), authController.login);

// GET /api/v1/auth/portal-invite/validate - deep link from invitation email
router.get('/portal-invite/validate', validateQuery(portalInviteValidateQuerySchema), portalInvitationController.validatePortalInvite);

// POST /api/v1/auth/portal-invite/complete - set password + session
router.post('/portal-invite/complete', validateBody(portalInviteCompleteSchema), portalInvitationController.completePortalInvite);

// POST /api/v1/auth/forgot-password
router.post('/forgot-password', validateBody(forgotPasswordSchema), authController.forgotPassword);

// POST /api/v1/auth/verify-reset-otp
router.post('/verify-reset-otp', validateBody(verifyResetOtpSchema), authController.verifyResetOtp);

// POST /api/v1/auth/verify-otp-reset-password
router.put('/verify-otp-reset-password', validateBody(verifyOtpSchema), authController.verifyOtpAndResetPassword);

// POST /api/v1/auth/send-mfa-otp
router.post('/send-mfa-otp', validateBody(sendMfaOtpSchema), authController.sendMfaOtp);

// POST /api/v1/auth/verify-mfa-otp
router.post('/verify-mfa-otp', validateBody(verifyMfaOtpSchema), authController.verifyMfaOtp);

// POST /api/v1/auth/refresh
// GET /refresh-token removed - GET requests with query params are CSRF-vulnerable (CWE-352).
router.post('/refresh', validateBody(refreshTokenSchema), authController.refreshToken);

// POST /api/v1/auth/logout
router.post('/logout', authMiddleware, authorize, lockCheckMiddleware, authController.logout);

// PUT /api/v1/auth/lock-account
router.put('/lock-account', authMiddleware, authorize, lockCheckMiddleware, validateBody(lockAccountSchema), authController.lockAccount);

// PUT /api/v1/auth/unlock-account
router.put('/unlock-account', authMiddleware, authorize, lockCheckMiddleware, validateBody(unlockAccountSchema), authController.unlockAccount);

// GET /api/v1/auth/session
router.get('/session', authMiddleware, authorize, lockCheckMiddleware, authController.getSession);

// PUT /api/v1/auth/reset-password
router.put('/reset-password', authMiddleware, authorize, lockCheckMiddleware, validateBody(resetPasswordSchema), authController.resetPassword);

// Trusted devices + login history (authenticated)
router.get(
  '/trusted-devices',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  authController.listTrustedDevices
);
router.patch(
  '/trusted-devices/:id',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  validateBody(renameTrustedDeviceSchema),
  authController.renameTrustedDevice
);
router.delete(
  '/trusted-devices/:id',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  validateParams(idParamSchema),
  authController.revokeTrustedDevice
);
router.get(
  '/login-history',
  authMiddleware,
  authorize,
  lockCheckMiddleware,
  authController.getLoginHistory
);

// Mount roles routes at /api/v1/auth (roles routes will handle /signup-roles, /role, etc.)
router.use('/', rolesRouter);

// GET /api/v1/auth/public/masterdata?keys=HOA_Association_Types
// This public endpoint helps onboarding forms load shared reference data before a user has a session.
// Only a fixed allowlist of keys is served to prevent data leakage.
const MasterData = require('../../master/model/masterData.model');
const { MASTER_DATA_KEYS } = require('../../../../common/constants/masterDataKeys');
const PUBLIC_MASTERDATA_KEYS = [MASTER_DATA_KEYS.HOA_ASSOCIATION_TYPES];
router.get('/public/masterdata', async (req, res) => {
  try {
    let keys = req.query.keys;
    if (!keys) return res.status(400).json({ message: 'keys query param is required' });
    if (!Array.isArray(keys)) keys = [keys];
    const allowed = keys.filter((k) => PUBLIC_MASTERDATA_KEYS.includes(k));
    if (allowed.length === 0) return res.status(400).json({ message: 'No valid keys requested' });
    const records = await MasterData.find({ key: { $in: allowed } }).lean();
    res.json({ data: records });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
