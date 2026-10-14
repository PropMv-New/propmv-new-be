/**
 * ------------------------------------------------------------------
 * File: auth.controller.js
 * Module: Src Shared Modules Auth Controllers
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * auth.routes
 * ------------------------------------------------------------------
 */

const authService = require('../services/auth.service');
const logger = require('../../../../common/logger');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');
const { connectToDatabase } = require('../../../../database');
const { ConflictError, UnauthorizedError, ValidationError } = require('../../../../common/exceptions');
const { OtpResendLimitedError } = require('../../../../services/otpResendLimiter.service');
const {
  DUPLICATE_EMAIL_MESSAGE,
  DUPLICATE_PHONE_MESSAGE,
} = require('../../users/helpers/userIdentityValidation');
const { buildLoginMetaFromRequest } = require('../helpers/loginMeta.helper');
const { getTrustedDeviceDays } = require('../helpers/deviceFingerprint.helper');

function otpResendMetaPayload(meta) {
  if (!meta) return {};
  return {
    retryAfterSeconds: meta.retryAfterSeconds,
    resendAvailableAt: meta.resendAvailableAt,
    resendCount: meta.resendCount,
  };
}

function handleOtpResendLimited(err, res) {
  if (!(err instanceof OtpResendLimitedError)) return false;
  res.setHeader('Retry-After', String(err.retryAfterSeconds));
  res.status(429).json({
    message: err.message,
    data: {
      retryAfterSeconds: err.retryAfterSeconds,
      resendAvailableAt: err.resendAvailableAt,
      resendCount: err.resendCount,
    },
    statuscode: 429,
  });
  return true;
}

const checkIdentity = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'checkIdentity' });
  try {
    await connectToDatabase();
    const result = await authService.checkIdentityAvailability(req.query);
    res.json({
      data: result,
      message: 'Identity availability checked',
      statuscode: 200,
    });
  } catch (err) {
    logger.error('Check identity error:', err);
    if (err.message.includes('validation') || err.message.includes('required')) {
      return next(new ValidationError(err.message));
    }
    next(err);
  }
};

const signup = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'signup' });
  try {
    await connectToDatabase();
    const result = await authService.register(req.body);
    const resumed = !!result?.existingUnverifiedAccount;
    const emailDeliveryFailed = !!result?.emailDeliveryFailed;
    let message = resumed
      ? 'An unverified account already exists for this email. We sent a new verification code.'
      : 'Registration successful';
    if (emailDeliveryFailed) {
      message =
        "We're having trouble sending your verification email right now. Please try again shortly.";
    } else if (!resumed) {
      message = 'Verification email sent successfully.';
    }
    res.status(resumed ? 200 : 201).json({
      data: result,
      message,
      statuscode: resumed ? 200 : 201,
    });
  } catch (err) {
    logger.error('Signup error:', err);
    
    if (
      err.message === 'Email already exists' ||
      err.message === DUPLICATE_EMAIL_MESSAGE ||
      err.field === 'email'
    ) {
      return next(new ConflictError(DUPLICATE_EMAIL_MESSAGE));
    }

    if (err.message === DUPLICATE_PHONE_MESSAGE || err.field === 'phone') {
      return next(new ConflictError(DUPLICATE_PHONE_MESSAGE));
    }
    
    if (err.message.includes('validation') || err.message.includes('required')) {
      return next(new ValidationError(err.message));
    }
    
    next(err);
  }
};

const login = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'login' });
  try {
    // Database connection is already established at app startup
    // No need to call connectToDatabase() on every request
    const loginMeta = await buildLoginMetaFromRequest(req);
    const result = await authService.login({
      ...req.body,
      loginMeta,
    });
    res.json({
      data: result,
      message: 'Login successful',
      statuscode: 200
    });
  } catch (err) {
    logger.error('Login error:', err);
    
    // Handle user not found
    if (err.message.includes('No account found')) {
      return next(new UnauthorizedError(err.message));
    }
    
    // Handle incorrect password with remaining attempts
    if (err.message.includes('Incorrect password')) {
      return next(new UnauthorizedError(err.message));
    }
    
    // Handle account locked
    if (err.message.includes('Account locked') || err.message.includes('temporarily locked')) {
      const error = new Error(err.message);
      error.status = 423; // 423 Locked
      return next(error);
    }

    if (err.status === 403) {
      const error = new Error(err.message);
      error.status = 403;
      return next(error);
    }
    
    // Generic fallback
    next(new UnauthorizedError(err.message || 'Login failed'));
  }
};

const refreshToken = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'refreshToken' });
  try {
    await connectToDatabase();
    const token = await authService.refreshToken(req.body.refreshToken);
    res.json(token);
  } catch (err) {
    logger.error('Refresh token error:', err);
    next(new UnauthorizedError(err.message));
  }
};

const logout = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'logout' });
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    await authService.logout(userId);
    res.status(200).json({ message: 'Logout successful' });
  } catch (err) {
    logger.error('Logout error:', err);
    next(err);
  }
};

const forgotPassword = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'forgotPassword' });
  try {
    await connectToDatabase();
    const { email, resend } = req.body;
    const result = await authService.forgotPassword({ email, resend });
    res.json({
      message: 'OTP has been sent to your email address.',
      data: otpResendMetaPayload(result?.otpResendMeta),
      statuscode: 200,
    });
  } catch (err) {
    logger.error('Forgot password error:', err);
    if (handleOtpResendLimited(err, res)) return;
    if (err.message === 'Email not found') {
      return res.status(404).json({ message: 'Email not found.' });
    }
    next(err);
  }
};

const verifyResetOtp = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'verifyResetOtp' });
  try {
    await connectToDatabase();
    await authService.verifyResetOtp(req.body);
    res.json({ message: 'OTP verified successfully' });
  } catch (err) {
    logger.error('Verify reset OTP error:', err);
    if (err.message === 'Invalid email or OTP' || err.message === 'Invalid OTP') {
      return next(new UnauthorizedError(err.message));
    }
    if (err.message.includes('expired')) {
      return next(new UnauthorizedError(err.message));
    }
    next(err);
  }
};

const verifyOtpAndResetPassword = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'verifyOtpAndResetPassword' });
  try {
    await connectToDatabase();
    await authService.verifyOtpAndResetPassword(req.body);
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    logger.error('Verify OTP and reset password error:', err);
    if (err.message === 'Invalid email or OTP') {
      return next(new UnauthorizedError('Invalid email or OTP'));
    }
    if (err.message === 'Invalid OTP') {
      return next(new UnauthorizedError('Invalid OTP'));
    }
    if (err.message && err.message.includes('expired')) {
      return next(new UnauthorizedError(err.message));
    }
    if (
      err.message && (
        err.message.includes('Password validation failed') ||
        err.message.includes('do not match') ||
        err.message.includes('Passwords must be encrypted')
      )
    ) {
      return next(new ValidationError(err.message));
    }
    next(err);
  }
};

const resetPassword = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'resetPassword' });
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    await authService.resetPassword(Object.assign({}, req.body, { userId }));
    // Audit middleware maps this to PasswordChanged (no password values logged)
    req.auditEvent = 'PasswordChanged';
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    // Never log password values - only the error message
    logger.error('Reset password error:', err.message);
    if (err.message === 'Current password is incorrect') {
      return next(new UnauthorizedError('Current password is incorrect.'));
    }
    if (err.message === 'User not found') {
      return next(new UnauthorizedError('Unable to update password. Please try again.'));
    }
    if (
      err.message && (
        err.message.includes('Password') ||
        err.message.includes('password') ||
        err.message.includes('do not match') ||
        err.message.includes('must be encrypted') ||
        err.message.includes('required')
      )
    ) {
      return next(new ValidationError(err.message));
    }
    return next(new ValidationError('Unable to update password. Please try again.'));
  }
};

const lockAccount = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'lockAccount' });
  try {
    await connectToDatabase();
    const { userId } = req.body;
    const result = await authService.lockAccount(userId);
    res.json(result);
  } catch (err) {
    logger.error('Lock account error:', err);
    next(err);
  }
};

const unlockAccount = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'unlockAccount' });
  try {
    await connectToDatabase();
    const { userId } = req.body;
    const authenticatedUserId = req.userId || req.user?.id;
    const result = await authService.unlockAccount(userId, authenticatedUserId);
    res.json(result);
  } catch (err) {
    logger.error('Unlock account error:', err);
    next(err);
  }
};

const getSession = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getSession' });
  try {
    await connectToDatabase();
    const userId = req.userId || (req.user && req.user.id);
    const result = await authService.getSession(userId);
    res.json(result);
  } catch (err) {
    logger.error('Get session error:', err);
    next(err);
  }
};

const sendMfaOtp = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'sendMfaOtp' });
  try {
    await connectToDatabase();
    const result = await authService.sendMfaOtp(req.body);
    const emailDeliveryFailed = !!result?.emailDeliveryFailed;
    res.json({
      message: emailDeliveryFailed
        ? "We're having trouble sending your verification email right now. Please try again shortly."
        : 'Verification email sent successfully.',
      data: {
        emailDeliveryFailed,
        ...otpResendMetaPayload(result?.otpResendMeta),
        ...(result?.devOtp ? { devOtp: result.devOtp } : {}),
      },
      statuscode: 200,
    });
  } catch (err) {
    logger.error('Send MFA OTP error:', err);
    if (handleOtpResendLimited(err, res)) return;
    next(err);
  }
};

const verifyMfaOtp = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'verifyMfaOtp' });
  try {
    await connectToDatabase();
    const loginMeta = await buildLoginMetaFromRequest(req);
    const result = await authService.verifyMfaOtp({
      ...req.body,
      loginMeta,
    });
    res.json({ message: 'OTP verified successfully', data: result });
  } catch (err) {
    logger.error('Verify MFA OTP error:', err);
    if (err.message === 'Invalid email or OTP') {
      return next(new UnauthorizedError('Invalid email or OTP'));
    }
    if (err.message === 'Invalid OTP') {
      return next(new UnauthorizedError('Invalid OTP'));
    }
    if (err.message === 'No active MFA OTP. Please request a new MFA OTP.') {
      return next(new UnauthorizedError(err.message));
    }
    if (err.message.includes('expired')) {
      return next(new UnauthorizedError(err.message));
    }
    if (err.status === 403) {
      const error = new Error(err.message);
      error.status = 403;
      return next(error);
    }
    next(err);
  }
};

const listTrustedDevices = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'listTrustedDevices' });
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const devices = await authService.listTrustedDevices(userId);
    res.json({
      data: devices,
      message: 'Trusted devices fetched',
      statuscode: 200,
    });
  } catch (err) {
    logger.error('List trusted devices error:', err);
    next(err);
  }
};

const renameTrustedDevice = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'renameTrustedDevice' });
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const device = await authService.renameTrustedDevice(
      userId,
      req.params.id,
      req.body.deviceName
    );
    res.json({
      data: device,
      message: 'Trusted device renamed',
      statuscode: 200,
    });
  } catch (err) {
    logger.error('Rename trusted device error:', err);
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({
        message: err.message,
        statuscode: err.status,
        data: null,
      });
    }
    next(err);
  }
};

const revokeTrustedDevice = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'revokeTrustedDevice' });
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const result = await authService.revokeTrustedDevice(userId, req.params.id);
    res.json({
      data: result,
      message: 'Trusted device removed',
      statuscode: 200,
    });
  } catch (err) {
    logger.error('Revoke trusted device error:', err);
    if (err.status === 404) {
      return res.status(404).json({
        message: err.message,
        statuscode: 404,
        data: null,
      });
    }
    next(err);
  }
};

const getLoginHistory = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getLoginHistory' });
  try {
    await connectToDatabase();
    const userId = req.userId || req.user?.id;
    const history = await authService.getLoginHistory(userId, {
      limit: req.query.limit,
      offset: req.query.offset,
      from: req.query.from,
      to: req.query.to,
      sort: req.query.sort,
      q: req.query.q,
      status: req.query.status,
    });
    res.json({
      data: history,
      message: 'Login history fetched',
      statuscode: 200,
    });
  } catch (err) {
    logger.error('Get login history error:', err);
    if (err.status === 404) {
      return res.status(404).json({
        message: err.message,
        statuscode: 404,
        data: null,
      });
    }
    next(err);
  }
};

const getAuthConfig = (req, res) => {
  res.json({
    data: {
      trustedDeviceDays: getTrustedDeviceDays(),
    },
    message: 'OK',
    statuscode: 200,
  });
};

module.exports = {
  checkIdentity,
  signup,
  login,
  refreshToken,
  logout,
  forgotPassword,
  verifyResetOtp,
  verifyOtpAndResetPassword,
  resetPassword,
  lockAccount,
  unlockAccount,
  getSession,
  sendMfaOtp,
  verifyMfaOtp,
  listTrustedDevices,
  renameTrustedDevice,
  revokeTrustedDevice,
  getLoginHistory,
  getAuthConfig,
};
