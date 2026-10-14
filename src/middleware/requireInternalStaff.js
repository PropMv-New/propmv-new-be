'use strict';

const logger = require('../common/logger');
const User = require('../shared/modules/users/models/user.model');
const companyRoleHelper = require('../common/helpers/companyRoleHelper');

const ALLOWED_INTERNAL_ROLES = new Set([
  'admin',
  'administrator',
  'super admin',
  'super_admin',
  'internal staff',
  'prop mv administrator',
  'propmv administrator',
  'platform admin',
]);

const ALLOWED_INTERNAL_PRIVILEGES = new Set([
  'VIEW_INTERNAL_REPORTS',
  'MANAGE_INTERNAL_REPORTS',
  'INTERNAL_STAFF',
  'SUPER_ADMIN',
  'ADMIN_ACCESS',
]);

/**
 * Dedicated internal staff authorization boundary for system reporting.
 *
 * Stricter than requireMarketingAdministrator or req.user.isAdministrator:
 * Customer Property Managers have companies with embedded roles named "Administrator".
 * This middleware validates:
 * 1. Request is authenticated (valid user id).
 * 2. User account exists and is not deleted.
 * 3. User's company matches the canonical PropMv internal company.
 * 4. User has an active administrative role/privilege in PropMv (or is configured internal staff).
 */
async function requireInternalStaff(req, res, next) {
  try {
    const userId = req.userId || req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({
        status: false,
        statusCode: 401,
        message: 'Authentication is required.',
        data: null,
      });
    }

    const userDoc = await User.findById(userId).lean();
    if (!userDoc || userDoc.isDeleted === true) {
      return res.status(403).json({
        status: false,
        statusCode: 403,
        message: 'Access denied: User account is inactive or not found.',
        data: null,
      });
    }

    const propMvCompany = await companyRoleHelper.getPropMvCompany();
    if (!propMvCompany) {
      logger.error('[requireInternalStaff] Canonical PropMv company not configured in database');
      return res.status(403).json({
        status: false,
        statusCode: 403,
        message: 'Internal authorization is unavailable.',
        data: null,
      });
    }

    const userCompanyId = String(userDoc.companyId || '');
    const propMvCompanyId = String(propMvCompany._id || '');

    // Canonical PropMv platform company check - blocks customer Property Manager companies
    if (!userCompanyId || userCompanyId !== propMvCompanyId) {
      logger.warn('[requireInternalStaff] Access denied: User does not belong to PropMv internal company', {
        userId: String(userId),
        userCompanyId,
        propMvCompanyId,
        userRole: userDoc.role,
      });
      return res.status(403).json({
        status: false,
        statusCode: 403,
        message: 'Access denied: PropMv internal staff access required.',
        data: null,
      });
    }

    // Role / Privilege verification within the PropMv company
    const resolvedRole = await companyRoleHelper.resolveUserRole(userDoc, { company: propMvCompany });
    const normalizedName = companyRoleHelper.normalizeRoleName(resolvedRole?.name || userDoc.role);

    const hasInternalRole = ALLOWED_INTERNAL_ROLES.has(normalizedName);
    const hasInternalPrivilege =
      Array.isArray(resolvedRole?.privileges) &&
      resolvedRole.privileges.some((p) =>
        ALLOWED_INTERNAL_PRIVILEGES.has(String(p).toUpperCase())
      );

    // NOTE: Report recipient configuration (HOA_ONBOARDING_REPORT_EMAIL / support@propmv.com) MUST NEVER grant authorization.
    if (!hasInternalRole && !hasInternalPrivilege) {
      logger.warn('[requireInternalStaff] Access denied: Insufficient internal privileges', {
        userId: String(userId),
        roleName: resolvedRole?.name,
      });
      return res.status(403).json({
        status: false,
        statusCode: 403,
        message: 'Access denied: Insufficient internal staff privileges.',
        data: null,
      });
    }

    req.internalStaff = {
      userId: String(userId),
      email: userDoc.email,
      role: resolvedRole?.name || userDoc.role,
      companyId: propMvCompanyId,
    };

    next();
  } catch (err) {
    logger.error('[requireInternalStaff] Authorization error', { error: err.message });
    return res.status(500).json({
      status: false,
      statusCode: 500,
      message: 'Internal authorization check failed.',
      data: null,
    });
  }
}

module.exports = requireInternalStaff;
