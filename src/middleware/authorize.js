/**
 * ------------------------------------------------------------------
 * File: authorize.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for authorize.
 *
 * Used By:
 * auth.routes, zillow.routes, billingSettings.routes, activity.routes
 * ------------------------------------------------------------------
 */

// Authorization middleware - Step 3 of the landlord API pipeline.
// Common middleware for all portals (Landlord, HOA, etc.)
//
// LANDLORD PIPELINE STEPS EMITTED
//   AUTHORIZE_START - privilege resolution begins
//   AUTHORIZE_OK    - user has at least one required privilege (or route is intentionally open)
//   AUTHORIZE_FAIL  - not authenticated, no privileges, insufficient privileges, or unmapped route
//
// PRIVILEGE LOGIC (fail-closed)
// 1. Privileges come from JWT (auth middleware) or DB fallback
// 2. Route → required privileges resolved via apiPrivilegeCheck + privilege maps
// 3. User needs AT LEAST ONE required privilege (OR logic)
// 4. Empty user privilege list → 403
// 5. No privilege-map entry → 403 unless route is on UNPRIVILEGED_ROUTE_ALLOWLIST
// 6. Map entry with [] → auth-only (any user with ≥1 privilege)
//
// Usage: router.get('/path', authMiddleware, authorize, controller.action);
const userProfileService = require('../shared/modules/users/services/userProfile.service');
const {
  lookupRequiredPrivilegesForRoute,
  normalizePrivilegePath,
} = require('./apiPrivilegeCheck');
const { isLandlordRequest, logLandlordFlow } = require('../portals/landlord/utils/landlordFlowLog');
const { PRIVILEGE_MAPS, UNPRIVILEGED_ROUTE_ALLOWLIST } = require('../privileges');

function getRouteLookupKey(req) {
  const routePath = req.route && req.route.path ? (req.baseUrl || '') + req.route.path : req.originalUrl;
  const normalizedPath = normalizePrivilegePath(routePath);
  return `${(req.method || 'GET').toUpperCase()} ${normalizedPath}`;
}

function lookupRequiredPrivileges(req) {
  const routePath = req.route && req.route.path ? (req.baseUrl || '') + req.route.path : req.originalUrl;
  return lookupRequiredPrivilegesForRoute(req.method, routePath, PRIVILEGE_MAPS);
}

async function authorize(req, res, next) {
  const landlord = isLandlordRequest(req);

  try {
    if (landlord) {
      logLandlordFlow('AUTHORIZE_START', {
        requestId: req.landlordRequestId,
        userId: req.userId,
      });
    }

    const userId = req.userId || (req.user && req.user.id);
    if (!userId) {
      if (landlord) {
        logLandlordFlow('AUTHORIZE_FAIL', {
          requestId: req.landlordRequestId,
          reason: 'not_authenticated',
        });
      }
      return res.status(401).json({ message: 'User not authenticated' });
    }

    let privileges = req.userPrivileges;

    if (!privileges) {
      try {
        ({ privileges } = await userProfileService.getPrivileges(userId));
        req.userPrivileges = privileges || [];
      } catch (err) {
        if (landlord) {
          logLandlordFlow('AUTHORIZE_FAIL', {
            requestId: req.landlordRequestId,
            userId,
            reason: 'user_not_found',
          });
        }
        return res.status(401).json({ message: 'User not found' });
      }
    }

    if (!privileges || privileges.length === 0) {
      if (landlord) {
        logLandlordFlow('AUTHORIZE_FAIL', {
          requestId: req.landlordRequestId,
          userId,
          reason: 'no_privileges',
        });
      }
      return res.status(403).json({
        message: 'Authorization failed: no privileges assigned',
        statuscode: 403,
        data: null,
      });
    }

    const { found, privileges: requiredPrivileges } = lookupRequiredPrivileges(req);
    const routeKey = getRouteLookupKey(req);

    if (!found) {
      if (UNPRIVILEGED_ROUTE_ALLOWLIST.has(routeKey)) {
        if (landlord) {
          logLandlordFlow('AUTHORIZE_OK', {
            requestId: req.landlordRequestId,
            userId,
            outcome: 'allowlisted_unprivileged_route',
            routeKey,
          });
        }
        return next();
      }

      if (landlord) {
        logLandlordFlow('AUTHORIZE_FAIL', {
          requestId: req.landlordRequestId,
          userId,
          reason: 'no_route_privilege_mapping',
          routeKey,
        });
      }
      return res.status(403).json({
        message: 'Authorization failed: route has no privilege mapping',
        statuscode: 403,
        data: null,
      });
    }

    // Explicit map entry with [] → intentionally auth-only
    if (!requiredPrivileges || requiredPrivileges.length === 0) {
      if (landlord) {
        logLandlordFlow('AUTHORIZE_OK', {
          requestId: req.landlordRequestId,
          userId,
          outcome: 'mapped_auth_only_route',
          routeKey,
        });
      }
      return next();
    }

    const hasAccess = requiredPrivileges.some((requiredPriv) => {
      const normalizedRequired = (requiredPriv || '').trim();
      return privileges.includes(normalizedRequired);
    });

    if (!hasAccess) {
      if (landlord) {
        logLandlordFlow('AUTHORIZE_FAIL', {
          requestId: req.landlordRequestId,
          userId,
          reason: 'insufficient_privileges',
          requiredCount: requiredPrivileges.length,
        });
      }
      return res.status(403).json({
        message: 'Authorization failed: insufficient privileges',
        statuscode: 403,
        data: null,
      });
    }

    if (landlord) {
      logLandlordFlow('AUTHORIZE_OK', {
        requestId: req.landlordRequestId,
        userId,
        requiredCount: requiredPrivileges.length,
      });
    }

    next();
  } catch (err) {
    if (landlord) {
      logLandlordFlow('AUTHORIZE_FAIL', {
        requestId: req.landlordRequestId,
        userId: req.userId,
        reason: 'authorize_exception',
        error: err?.message,
      });
    }
    return res.status(403).json({
      message: 'Authorization failed',
      statuscode: 403,
      data: null,
    });
  }
}

module.exports = authorize;
module.exports.lookupRequiredPrivileges = lookupRequiredPrivileges;
module.exports.UNPRIVILEGED_ROUTE_ALLOWLIST = UNPRIVILEGED_ROUTE_ALLOWLIST;
module.exports.PRIVILEGE_MAPS = PRIVILEGE_MAPS;
