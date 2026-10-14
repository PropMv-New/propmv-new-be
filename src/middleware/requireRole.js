/**
 * ------------------------------------------------------------------
 * File: requireRole.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for requireRole.
 *
 * Used By:
 * billingSettings.routes, hoa.routes, owner.routes
 * ------------------------------------------------------------------
 */

/**
 * Express middleware that restricts access to specific company roles.
 *
 * Usage:
 *   router.get('/path', authMiddleware, requireRole('HOA Board Member'), handler);
 *   router.get('/path', authMiddleware, requireRole(['HOA Owner', 'Tenant']), handler);
 */

const { isHOABoardMemberRole } = require('../common/helpers/hoaBoardRole');
const { isHOAOwnerRole } = require('../common/helpers/hoaOwnerRole');

/**
 * normalize Role Name
 *
 * Performs logic operations for normalizeRoleName.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function normalizeRoleName(role) {
  if (!role) return '';
  const name = typeof role === 'object' && role !== null && role.name
    ? String(role.name)
    : String(role);
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * role Matches
 *
 * Performs logic operations for roleMatches.
 *
 * @param userRole - Request/input argument
 * @param allowed - Request/input argument
 * @returns Operations result
 */
function roleMatches(userRole, allowed) {
  const userNorm = normalizeRoleName(userRole);
  const allowedNorm = normalizeRoleName(allowed);
  return userNorm === allowedNorm
    || (allowedNorm === 'hoa board member' && isHOABoardMemberRole(userRole))
    || (allowedNorm === 'hoa owner' && isHOAOwnerRole(userRole));
}

/**
 * require Role
 *
 * Performs logic operations for requireRole.
 *
 * @param allowedRoles - Request/input argument
 * @returns Operations result
 */
function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole) {
      return res.status(401).json({ message: 'User not authenticated', statuscode: 401, data: null });
    }

    const allowed = roles.some((role) => roleMatches(userRole, role));
    if (!allowed) {
      return res.status(403).json({
        message: 'Authorization failed: role not permitted for this resource',
        statuscode: 403,
        data: null,
      });
    }

    return next();
  };
}

module.exports = requireRole;
