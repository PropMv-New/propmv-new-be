/**
 * ------------------------------------------------------------------
 * File: auth.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for auth.
 *
 * Used By:
 * auth.routes, zillow.routes, hoa-board, billingSettings.routes
 * ------------------------------------------------------------------
 */

/**
 * JWT authentication middleware - Step 2 of the landlord API pipeline.
 *
 * SHARED ACROSS ALL PORTALS (Landlord, HOA, etc.)
 * For landlord routes (`/api/v1/landlord/*`), this middleware emits structured
 * AUTH_* steps correlated by `req.landlordRequestId` (set in Step 1).
 *
 * PIPELINE STEPS EMITTED (landlord only)
 *   AUTH_START  - Bearer token validation begins
 *   AUTH_OK     - Token valid; req.userId and req.user populated
 *   AUTH_FAIL   - Missing, expired, or malformed token
 *
 * ATTACHES TO REQUEST
 *   req.userId, req.user, req.userPrivileges (from JWT claims)
 *   req.user.companyId, req.user.isAdministrator (optional DB lookup)
 *
 * @see portals/landlord/utils/landlordFlowLog.js
 */
const jwt = require('jsonwebtoken');
const config = require('../config/default');
const User = require('../shared/modules/users/models/user.model');
const logger = require('../common/logger');
const { DateUtil } = require('../common/date');
const { isLandlordRequest, logLandlordFlow } = require('../portals/landlord/utils/landlordFlowLog');

const authMiddleware = async (req, res, next) => {
  const landlord = isLandlordRequest(req);

  try {
    // Prior middleware may have already resolved the user (e.g. internal calls).
    if (req.userId) {
      if (landlord) {
        logLandlordFlow('AUTH_OK', {
          requestId: req.landlordRequestId,
          userId: req.userId,
          outcome: 'cached',
        }, 'User already authenticated on request');
      }
      return next();
    }

    if (landlord) {
      logLandlordFlow('AUTH_START', { requestId: req.landlordRequestId });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (landlord) {
        logLandlordFlow('AUTH_FAIL', {
          requestId: req.landlordRequestId,
          reason: 'missing_bearer_token',
        });
      }
      return res.status(401).json({ message: 'Access token required' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET || config.jwt.secret);

    req.userId = decoded.sub;
    req.user = {
      _id: decoded.sub,
      id: decoded.sub,
      role: decoded.role,
    };

    if (decoded.privileges && Array.isArray(decoded.privileges)) {
      req.userPrivileges = decoded.privileges;
    }

    // Optional: enrich with company role for Administrator scoping (non-blocking on failure).
    // Load the fields hoaDataIsolation / lockCheck also need so downstream middleware
    // can reuse req.authUser / req.authCompany instead of re-querying.
    try {
      const AUTH_USER_SELECT =
        'companyId companyRoleId lockAccount lockUntil failedLoginAttempts isDeleted email hoaInfo propertyIds associatedHoaIds associatedLandlordIds credentialsChangedAt';
      const userDoc = await User.findOne({ _id: decoded.sub, isDeleted: { $ne: true } })
        .select(AUTH_USER_SELECT)
        .lean();

      if (userDoc) {
        // Reject access tokens minted before a password change (other devices / stolen JWTs)
        if (userDoc.credentialsChangedAt && typeof decoded.iat === 'number') {
          const changedMs = DateUtil.toEpoch(userDoc.credentialsChangedAt);
          if (Number.isFinite(changedMs) && decoded.iat * 1000 < changedMs) {
            if (landlord) {
              logLandlordFlow('AUTH_FAIL', {
                requestId: req.landlordRequestId,
                userId: decoded.sub,
                reason: 'credentials_changed',
              });
            }
            return res.status(401).json({ message: 'Session expired. Please log in again.' });
          }
        }

        req.authUser = userDoc;

        if (userDoc.companyId && userDoc.companyRoleId) {
          req.user.companyId = userDoc.companyId;
          req.user.companyRoleId = userDoc.companyRoleId;

          const Company = require('../shared/modules/company/models/company.model');
          const company = await Company.findOne({ _id: userDoc.companyId, isDeleted: { $ne: true } })
            .select('roles')
            .lean();

          if (company) {
            req.authCompany = company;
          }

          if (company && company.roles) {
            const userRole = company.roles.find(
              (r) => r._id.toString() === userDoc.companyRoleId.toString() && r.isActive
            );

            if (userRole && userRole.name === 'Administrator') {
              req.user.isAdministrator = true;
            }
            if (userRole?.name) {
              req.userRoleName = userRole.name;
            }
          }
        }
      }
    } catch (userFetchError) {
      logger.warn('Auth middleware: company details lookup failed', {
        userId: decoded.sub,
        error: userFetchError.message,
      });
    }

    if (landlord) {
      logLandlordFlow('AUTH_OK', {
        requestId: req.landlordRequestId,
        userId: req.userId,
        privilegeCount: Array.isArray(req.userPrivileges) ? req.userPrivileges.length : 0,
        isAdministrator: Boolean(req.user.isAdministrator),
      });
    }

    next();
  } catch (error) {
    if (landlord) {
      logLandlordFlow('AUTH_FAIL', {
        requestId: req.landlordRequestId,
        reason: error.name || 'auth_error',
        error: error.message,
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }

    return res.status(401).json({ message: 'Authentication failed' });
  }
};

module.exports = authMiddleware;
