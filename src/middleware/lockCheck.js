/**
 * ------------------------------------------------------------------
 * File: lockCheck.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for lockCheck.
 *
 * Used By:
 * auth.routes, activity.routes, dashboard.routes, invoice.routes
 * ------------------------------------------------------------------
 */

const User = require('../shared/modules/users/models/user.model');
const { ClockService } = require('../common/date');
const logger = require('../common/logger');

/**
 * Middleware to check if user account is locked
 * 
 * This middleware prevents locked users from accessing any API endpoints.
 * It should be applied after authentication middleware to ensure the user
 * is authenticated before checking lock status.
 * 
 * Features:
 * - Checks user's lock status from database
 * - Automatically unlocks expired accounts
 * - Blocks access for locked accounts
 * - Returns appropriate error messages
 * 
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */
const LOCK_FIELDS = 'lockAccount lockUntil failedLoginAttempts isDeleted email';

async function resolveLockUser(req, userId) {
  if (req.authUser && String(req.authUser._id) === String(userId)) {
    return req.authUser;
  }

  try {
    return await User.findById(userId).select(LOCK_FIELDS).lean();
  } catch (error) {
    logger.error('Error in resolveLockUser', { error: error.message });
    return null;
  }
}

const lockCheckMiddleware = async (req, res, next) => {
  try {
    const userId = req.userId || req.user?.id;

    if (!userId) {
      return res.status(401).json({
        message: 'User not authenticated'
      });
    }

    let userDoc = await resolveLockUser(req, userId);
    if (!userDoc) {
      return res.status(404).json({
        message: 'User not found'
      });
    }

    if (userDoc.isDeleted) {
      return res.status(403).json({
        message: 'User account has been deleted'
      });
    }

    if (userDoc.lockAccount && userDoc.lockUntil && userDoc.lockUntil <= ClockService.now()) {
      await User.updateOne(
        { _id: userId },
        { $set: { lockAccount: false, lockUntil: null, failedLoginAttempts: 0 } }
      );
      userDoc = { ...userDoc, lockAccount: false, lockUntil: null, failedLoginAttempts: 0 };
      logger.info('Account automatically unlocked after lock expiration', { email: userDoc.email });
    }

    if (userDoc.lockAccount && userDoc.lockUntil && userDoc.lockUntil > ClockService.now()) {
      return res.status(423).json({
        message: 'Account is temporarily locked due to multiple failed login attempts',
        lockUntil: userDoc.lockUntil,
        unlockTime: 'Account will be automatically unlocked after lock expiration'
      });
    }

    next();
  } catch (error) {
    logger.error('Lock check middleware error', { error: error.message, userId: req.userId || req.user?.id });
    res.status(500).json({
      message: 'Internal server error during lock verification',
      error: error.message
    });
  }
};

module.exports = lockCheckMiddleware;
