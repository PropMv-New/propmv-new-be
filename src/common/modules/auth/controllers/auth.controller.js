/**
 * ------------------------------------------------------------------
 * File: auth.controller.js
 * Module: Src Common Modules Auth Controllers
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * auth
 * ------------------------------------------------------------------
 */

const authService = require('../services/auth.service');
const logger = require('../../../logger');
const { connectToDatabase } = require('../../../../database');
const { ConflictError, UnauthorizedError, ValidationError } = require('../../../exceptions');

/**
 * create Auth Controller
 *
 * Performs logic operations for createAuthController.
 *
 * @param UserModel - Request/input argument
 * @returns Operations result
 */
function createAuthController(UserModel) {
  const signup = async (req, res, next) => {
    try {
      await connectToDatabase();
      const result = await authService.register({ ...req.body, UserModel });
      const message = result.emailDeliveryFailed
        ? 'Registration successful. We had trouble sending your verification email - please use Resend OTP.'
        : 'Registration successful';
      res.status(201).json({
        data: result,
        message,
        statuscode: 201
      });
    } catch (err) {
      logger.error('Signup error:', err.message);

      if (err.message === 'Email already exists') {
        return next(new ConflictError('Email already exists'));
      }

      if (err.message.includes('validation') || err.message.includes('required')) {
        return next(new ValidationError(err.message));
      }

      next(err);
    }
  };

  const login = async (req, res, next) => {
    try {
      await connectToDatabase();
      const result = await authService.login({
        ...req.body,
        UserModel,
        loginMeta: {
          ip: req.ip || req.headers['x-forwarded-for'] || null,
          userAgent: req.headers['user-agent'] || null,
        },
      });
      const message = result.emailDeliveryFailed
        ? 'Password verified. We had trouble sending your OTP - please use Resend OTP.'
        : 'Login successful';
      res.json({
        data: result,
        message,
        statuscode: 200
      });
    } catch (err) {
      logger.error('Login error:', err.message);

      if (err.message === 'Invalid credentials' || err.message === 'User not found') {
        return next(new UnauthorizedError('Invalid email or password'));
      }

      if (err.message === 'Account is locked') {
        const error = new Error('Account is locked');
        error.status = 423;
        return next(error);
      }

      next(new UnauthorizedError(err.message || 'Login failed'));
    }
  };

  const refreshToken = async (req, res, next) => {
    try {
      await connectToDatabase();
      const token = await authService.refreshToken(req.query.refreshToken, UserModel);
      res.json(token);
    } catch (err) {
      logger.error('Refresh token error:', err.message);
      next(new UnauthorizedError(err.message));
    }
  };

  const logout = async (req, res, next) => {
    try {
      await connectToDatabase();
      const userId = req.userId || req.user?.id;
      await authService.logout(userId, UserModel);
      res.status(200).json({ message: 'Logout successful' });
    } catch (err) {
      logger.error('Logout error:', err.message);
      next(err);
    }
  };

  const forgotPassword = async (req, res, next) => {
    try {
      await connectToDatabase();
      const { email } = req.body;
      const result = await authService.forgotPassword({ email, UserModel });
      const message = result && result.emailDeliveryFailed
        ? 'If the email exists, we had trouble sending the OTP. Please try again shortly.'
        : 'If the email exists, an OTP has been sent to your email address.';
      res.json({ message });
    } catch (err) {
      logger.error('Forgot password error:', err.message);
      next(err);
    }
  };

  const verifyOtpAndResetPassword = async (req, res, next) => {
    try {
      await connectToDatabase();
      await authService.verifyOtpAndResetPassword({ ...req.body, UserModel });
      res.json({ message: 'Password reset successful' });
    } catch (err) {
      logger.error('Verify OTP and reset password error:', err.message);
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
    try {
      await connectToDatabase();
      const userId = req.userId || req.user?.id;
      await authService.resetPassword({ ...req.body, userId, UserModel });
      res.json({ message: 'Password reset successful' });
    } catch (err) {
      logger.error('Reset password error:', err.message);
      next(err);
    }
  };

  const lockAccount = async (req, res, next) => {
    try {
      await connectToDatabase();
      const { userId } = req.body;
      const result = await authService.lockAccount(userId, UserModel);
      res.json(result);
    } catch (err) {
      logger.error('Lock account error:', err.message);
      next(err);
    }
  };

  const unlockAccount = async (req, res, next) => {
    try {
      await connectToDatabase();
      const { userId } = req.body;
      const authenticatedUserId = req.userId || req.user?.id;
      const result = await authService.unlockAccount(userId, authenticatedUserId, UserModel);
      res.json(result);
    } catch (err) {
      logger.error('Unlock account error:', err.message);
      next(err);
    }
  };

  const getSession = async (req, res, next) => {
    try {
      await connectToDatabase();
      const userId = req.userId || (req.user && req.user.id);
      const result = await authService.getSession(userId, UserModel);
      res.json(result);
    } catch (err) {
      logger.error('Get session error:', err.message);
      next(err);
    }
  };

  const sendMfaOtp = async (req, res, next) => {
    try {
      await connectToDatabase();
      const result = await authService.sendMfaOtp({ ...req.body, UserModel });
      const message = result && result.emailDeliveryFailed
        ? 'OTP generated but email delivery failed. Please try again shortly.'
        : 'OTP has been sent to your email address.';
      res.json({ message, emailDeliveryFailed: !!(result && result.emailDeliveryFailed) });
    } catch (err) {
      logger.error('Send MFA OTP error:', err.message);
      next(err);
    }
  };

  const verifyMfaOtp = async (req, res, next) => {
    try {
      await connectToDatabase();
      const result = await authService.verifyMfaOtp({
        ...req.body,
        UserModel,
        loginMeta: {
          ip: req.ip || req.headers['x-forwarded-for'] || null,
          userAgent: req.headers['user-agent'] || null,
        },
      });
      res.json({ message: 'OTP verified successfully', data: result });
    } catch (err) {
      logger.error('Verify MFA OTP error:', err.message);
      if (err.message === 'Invalid email or OTP') {
        return next(new UnauthorizedError('Invalid email or OTP'));
      }
      if (err.message === 'Invalid OTP') {
        return next(new UnauthorizedError('Invalid OTP'));
      }
      if (err.message.includes('expired')) {
        return next(new UnauthorizedError(err.message));
      }
      next(err);
    }
  };

  return {
    signup,
    login,
    refreshToken,
    logout,
    forgotPassword,
    verifyOtpAndResetPassword,
    resetPassword,
    lockAccount,
    unlockAccount,
    getSession,
    sendMfaOtp,
    verifyMfaOtp,
  };
}

module.exports = createAuthController;
