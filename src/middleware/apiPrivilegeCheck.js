/**
 * ------------------------------------------------------------------
 * File: apiPrivilegeCheck.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for apiPrivilegeCheck.
 *
 * Used By:
 * authorize landloard, authorize
 * ------------------------------------------------------------------
 */

/**
 * API Privilege Check Utility
 * 
 * This middleware provides centralized privilege-based access control for APIs.
 * It checks if a user has the required privileges to access a specific API endpoint.
 * 
 * Key Features:
 * - Supports multiple privileges per endpoint (OR logic - user needs at least ONE of the required privileges)
 * - Returns 403 Forbidden if user lacks access
 * - Works with user privileges fetched from userProfileService
 * - Can be used as a middleware or called directly in controllers
 * 
 * Usage:
 * 1. As middleware in routes:
 *    router.get('/endpoint', authMiddleware, authorize, checkApiPrivilege(['PRIVILEGE_NAME']), controller.action);
 * 
 * 2. In controller actions:
 *    const hasAccess = checkApiPrivilegeSync(req.user.privileges, ['PRIVILEGE_NAME']);
 *    if (!hasAccess) {
 *      return res.status(403).json({ message: 'Access Denied' });
 *    }
 */

/**
 * Synchronous privilege check - EXACT MATCHING
 * @param {string[]} userPrivileges - Array of privileges the user has (e.g., "VIEW_PROPERTY" or "VIEW_PROPERTY-1")
 * @param {string[]} requiredPrivileges - Array of required privileges (e.g., "VIEW_PROPERTY" or "VIEW_PROPERTY-1")
 * @returns {boolean} true if user has access (has at least one required privilege with exact match)
 */
function checkApiPrivilegeSync(userPrivileges = [], requiredPrivileges = []) {
  // If no required privileges specified, allow access
  if (!requiredPrivileges || requiredPrivileges.length === 0) {
    return true;
  }

  // If user has no privileges, deny access
  if (!userPrivileges || userPrivileges.length === 0) {
    return false;
  }

  // EXACT privilege matching - user must have the EXACT privilege string
  // No ID suffix stripping anymore. This means:
  // - User with "VIEW_PROPERTY" can access APIs requiring "VIEW_PROPERTY"
  // - User with "VIEW_PROPERTY-1" can access APIs requiring "VIEW_PROPERTY-1"
  // - User with "VIEW_PROPERTY-1" CANNOT access APIs requiring "VIEW_PROPERTY"
  // This ensures proper privilege scoping by resource ID
  
  return requiredPrivileges.some(requiredPriv => 
    userPrivileges.includes(requiredPriv)
  );
}

/**
 * Async middleware for privilege checking
 * @param {string[]} requiredPrivileges - Array of required privileges (user needs at least one)
 * @returns {Function} Express middleware function
 */
function checkApiPrivilege(requiredPrivileges = []) {
  return async (req, res, next) => {
    try {
      // If no required privileges specified, allow access
      if (!requiredPrivileges || requiredPrivileges.length === 0) {
        return next();
      }

      // Get user privileges from request (populated by authorize middleware)
      const userPrivileges = req.userPrivileges || [];

      // Check if user has access
      const hasAccess = checkApiPrivilegeSync(userPrivileges, requiredPrivileges);

      if (!hasAccess) {
        return res.status(403).json({
          message: 'Authorization failed: insufficient privileges',
          statuscode: 403,
          data: null
        });
      }

      next();
    } catch (err) {
      return res.status(403).json({
        message: 'Authorization failed',
        statuscode: 403,
        data: null
      });
    }
  };
}

/**
 * Helper function to get required privileges for a route from privilege maps
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE, etc.)
 * @param {string} path - API endpoint path (may include portal prefix like /api/v1/landlord or /api/v1/hoa)
 * @param {Object[]} privilegeMaps - Array of privilege definition objects
 * @returns {string[]} Array of required privileges
 */
function normalizePrivilegePath(path = '') {
  // Express often yields baseUrl + '/' for list routes (e.g. /api/v1/expense/).
  // Privilege maps use no trailing slash - normalize so lookups match.
  let normalized = String(path || '').split('?')[0];
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized
    .replace(/\/api\/v1\/landlord\//, '/api/v1/')
    .replace(/\/api\/v1\/hoa\//, '/api/v1/');
}

/**
 * Resolve privileges for a route.
 * @returns {{ found: boolean, privileges: string[] }}
 *   found=false → no map entry (fail-closed unless allow-listed)
 *   found=true + privileges=[] → intentionally auth-only
 */
function lookupRequiredPrivilegesForRoute(method, path, privilegeMaps = []) {
  const normalizedPath = normalizePrivilegePath(path);
  const methodKey = `${(method || 'GET').toUpperCase()} ${normalizedPath}`;

  for (const map of privilegeMaps) {
    if (Object.prototype.hasOwnProperty.call(map, methodKey)) {
      const privileges = map[methodKey];
      return {
        found: true,
        privileges: Array.isArray(privileges) ? privileges : privileges ? [privileges] : [],
      };
    }
  }

  for (const map of privilegeMaps) {
    if (Object.prototype.hasOwnProperty.call(map, normalizedPath)) {
      const privileges = map[normalizedPath];
      return {
        found: true,
        privileges: Array.isArray(privileges) ? privileges : privileges ? [privileges] : [],
      };
    }
  }

  return { found: false, privileges: [] };
}

/**
 * @deprecated Prefer lookupRequiredPrivilegesForRoute - empty array cannot distinguish miss vs auth-only.
 * Returns privileges when found; [] when not found OR intentionally empty (legacy).
 */
function getRequiredPrivilegesForRoute(method, path, privilegeMaps = []) {
  return lookupRequiredPrivilegesForRoute(method, path, privilegeMaps).privileges;
}

module.exports = {
  checkApiPrivilege,
  checkApiPrivilegeSync,
  getRequiredPrivilegesForRoute,
  lookupRequiredPrivilegesForRoute,
  normalizePrivilegePath,
};
