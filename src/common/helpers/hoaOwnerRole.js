/**
 * ------------------------------------------------------------------
 * File: hoaOwnerRole.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaOwnerRole.
 *
 * Used By:
 * contacts.service, hoaDataIsolation, hoaOwnerPropertyAccess, requireRole
 * ------------------------------------------------------------------
 */

const { ROLE_NAMES } = require('../constants/roleNames');
const {
  getCompanyRoleByName,
  getPropMvCompany,
  buildCompanyRoleUserFilter,
} = require('./companyRoleHelper');

let cachedOwnerRoleRefs = null;

/**
 * is H O A Owner Role
 *
 * Performs logic operations for isHOAOwnerRole.
 *
 * @param role - Request/input argument
 * @returns Operations result
 */
function isHOAOwnerRole(role) {
  if (!role) return false;
  const name = typeof role === 'object' && role !== null && role.name ? String(role.name) : String(role);
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return n === 'hoa owner' || n === 'hoa_owner';
}

async function getHOAOwnerRoleRefs(options = {}) {
  if (cachedOwnerRoleRefs && !options.refresh) return cachedOwnerRoleRefs;

  const companyRole = await getCompanyRoleByName(ROLE_NAMES.HOA_OWNER, null, options);
  if (!companyRole) {
    const err = new Error('HOA Owner role not found in company');
    err.status = 500;
    throw err;
  }

  cachedOwnerRoleRefs = {
    companyId: companyRole.companyId,
    roleId: companyRole.roleId,
    role: companyRole.role,
  };

  return cachedOwnerRoleRefs;
}

async function getHOAOwnerRole() {
  const refs = await getHOAOwnerRoleRefs();
  return {
    _id: refs.roleId,
    name: refs.role.name,
    description: refs.role.description,
    companyId: refs.companyId,
    source: 'company',
  };
}

async function getHOAOwnerRoleId() {
  const refs = await getHOAOwnerRoleRefs();
  return refs.roleId;
}

async function buildHOAOwnerUserFilter(extra = {}) {
  const refs = await getHOAOwnerRoleRefs();
  return buildCompanyRoleUserFilter(
    { companyId: refs.companyId, companyRoleId: refs.roleId },
    extra
  );
}

async function assignHOAOwnerRoleFields(userFields, options = {}) {
  const refs = await getHOAOwnerRoleRefs(options);
  userFields.companyId = refs.companyId;
  userFields.companyRoleId = refs.roleId;
  return userFields;
}

/**
 * clear H O A Owner Role Cache
 *
 * Performs logic operations for clearHOAOwnerRoleCache.
 *
 * @returns Operations result
 */
function clearHOAOwnerRoleCache() {
  cachedOwnerRoleRefs = null;
}

module.exports = {
  isHOAOwnerRole,
  getHOAOwnerRole,
  getHOAOwnerRoleId,
  getHOAOwnerRoleRefs,
  buildHOAOwnerUserFilter,
  assignHOAOwnerRoleFields,
  clearHOAOwnerRoleCache,
  getPropMvCompany,
};
