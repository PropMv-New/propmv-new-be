/**
 * ------------------------------------------------------------------
 * File: companyRoleHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for companyRoleHelper.
 *
 * Used By:
 * hoaOwnerRole, hoaTenantRole, maintenanceEmailHelper, contacts.service
 * ------------------------------------------------------------------
 */

const Company = require('../../shared/modules/company/models/company.model');
const logger = require('../logger');
const { COMPANY_NAME } = require('../constants/company');

let cachedPropMvCompany = null;
let cachedPropMvCompanyAt = 0;
const COMPANY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * normalize Role Name
 *
 * Performs logic operations for normalizeRoleName.
 *
 * @param name - Request/input argument
 * @returns Operations result
 */
function normalizeRoleName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * find Active Role By Name
 *
 * Performs logic operations for findActiveRoleByName.
 *
 * @param roles - Request/input argument
 * @param roleName - Request/input argument
 * @returns Operations result
 */
function findActiveRoleByName(roles, roleName) {
  if (!Array.isArray(roles)) return null;
  const target = normalizeRoleName(roleName);
  return roles.find((r) => r.isActive && normalizeRoleName(r.name) === target) || null;
}

/**
 * to Id String
 *
 * Performs logic operations for toIdString.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function toIdString(id) {
  if (!id) return '';
  return id.toString ? id.toString() : String(id);
}

/**
 * Fetch the default PropMv company (cached when no session).
 */
async function getPropMvCompany({ session, lean = true, refresh = false } = {}) {
  const cacheExpired = (Date.now() - cachedPropMvCompanyAt) > COMPANY_CACHE_TTL_MS;
  if (cachedPropMvCompany && !session && !refresh && !cacheExpired) {
    return cachedPropMvCompany;
  }

  let query = Company.findOne({ name: COMPANY_NAME, isDeleted: { $ne: true } });
  if (session) query = query.session(session);
  const company = lean ? await query.lean() : await query.exec();

  if (!company) {
    logger.warn(`Default company "${COMPANY_NAME}" not found`);
    return null;
  }

  if (!session) {
    cachedPropMvCompany = company;
    cachedPropMvCompanyAt = Date.now();
  }
  return company;
}

/**
 * Find an active embedded role by name within a company (or PropMv by default).
 */
async function getCompanyRoleByName(roleName, companyId = null, options = {}) {
  let company;
  if (companyId) {
    let query = Company.findOne({ _id: companyId, isDeleted: { $ne: true } });
    if (options.session) query = query.session(options.session);
    company = await query.lean();
  } else {
    company = await getPropMvCompany({ session: options.session });
  }

  if (!company) {
    logger.warn(`Company not found for role lookup: ${roleName}`);
    return null;
  }

  const role = findActiveRoleByName(company.roles, roleName);
  if (!role) {
    logger.warn(`Role "${roleName}" not found in company ${company._id}`);
    return null;
  }

  return {
    companyId: company._id,
    role,
    roleId: role._id,
  };
}

/**
 * Resolve a user's effective role from company embedded roles.
 */
async function resolveUserRole(user, options = {}) {
  if (!user?.companyId || !user?.companyRoleId) return null;

  let company = options.company;
  if (!company) {
    company = await Company.findOne({ _id: user.companyId, isDeleted: { $ne: true } }).lean();
  }
  if (!company?.roles) return null;

  const role = company.roles.find(
    (r) => toIdString(r._id) === toIdString(user.companyRoleId) && r.isActive
  );
  if (!role) return null;

  return {
    _id: role._id,
    name: role.name,
    description: role.description,
    privileges: Array.isArray(role.privileges) ? role.privileges : [],
    source: 'company',
    companyId: company._id,
    companyRoleId: role._id,
  };
}

async function resolveUserRoleName(user, options = {}) {
  const resolved = await resolveUserRole(user, options);
  return resolved?.name || null;
}

/**
 * Fetch user and resolve role in one call.
 */
async function fetchUserWithResolvedRole(userId, select = 'companyId companyRoleId') {
  const User = require('../../shared/modules/users/models/user.model');
  const user = await User.findById(userId).select(select).lean();
  if (!user) return { user: null, role: null };
  const role = await resolveUserRole(user);
  return { user, role };
}

/**
 * Build a Mongo filter matching users by company embedded role.
 */
function buildCompanyRoleUserFilter({ companyId, companyRoleId }, extra = {}) {
  return {
    companyId,
    companyRoleId,
    isDeleted: { $ne: true },
    ...extra,
  };
}

/**
 * Attach resolved company role to a user profile object for API responses.
 */
async function attachRoleToProfile(userProfile, user) {
  if (!userProfile || !user) return userProfile;
  const resolved = await resolveUserRole(user);
  if (resolved) {
    userProfile.role = {
      _id: resolved._id,
      name: resolved.name,
      description: resolved.description,
      privileges: resolved.privileges,
      source: 'company',
    };
  }
  return userProfile;
}

/**
 * Resolve intended role name from a portal invitation.
 */
async function resolveInvitationRoleName(inv) {
  if (!inv?.intendedRoleId) return '';

  if (inv.intendedCompanyId) {
    const company = await Company.findOne({ _id: inv.intendedCompanyId, isDeleted: { $ne: true } }).lean();
    const role = company?.roles?.find((r) => toIdString(r._id) === toIdString(inv.intendedRoleId));
    if (role?.name) return role.name;
  }

  const propMv = await getPropMvCompany();
  const embeddedRole = propMv?.roles?.find((r) => toIdString(r._id) === toIdString(inv.intendedRoleId));
  return embeddedRole?.name || '';
}

/**
 * Check whether a user's company role matches an invitation's intended role.
 */
function userMatchesInvitationRole(user, inv) {
  if (!user || !inv?.intendedRoleId || !user.companyId || !user.companyRoleId) return false;
  if (inv.intendedCompanyId && toIdString(user.companyId) !== toIdString(inv.intendedCompanyId)) {
    return false;
  }
  return toIdString(user.companyRoleId) === toIdString(inv.intendedRoleId);
}

/**
 * clear Prop Mv Company Cache
 *
 * Performs logic operations for clearPropMvCompanyCache.
 *
 * @returns Operations result
 */
function clearPropMvCompanyCache() {
  cachedPropMvCompany = null;
  cachedPropMvCompanyAt = 0;
}

module.exports = {
  normalizeRoleName,
  findActiveRoleByName,
  getPropMvCompany,
  getCompanyRoleByName,
  resolveUserRole,
  resolveUserRoleName,
  fetchUserWithResolvedRole,
  buildCompanyRoleUserFilter,
  attachRoleToProfile,
  resolveInvitationRoleName,
  userMatchesInvitationRole,
  clearPropMvCompanyCache,
};
