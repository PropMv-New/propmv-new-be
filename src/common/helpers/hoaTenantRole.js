/**
 * ------------------------------------------------------------------
 * File: hoaTenantRole.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaTenantRole.
 *
 * Used By:
 * tenant.service
 * ------------------------------------------------------------------
 */

const { ROLE_NAMES } = require('../constants/roleNames');
const {
  getCompanyRoleByName,
  buildCompanyRoleUserFilter,
} = require('./companyRoleHelper');

let cachedTenantRoleRefs = null;

async function getHOATenantRoleRefs(options = {}) {
  if (cachedTenantRoleRefs && !options.refresh) return cachedTenantRoleRefs;

  const companyRole = await getCompanyRoleByName(ROLE_NAMES.TENANT, null, options);
  if (!companyRole) {
    const err = new Error('Tenant role not found in company');
    err.status = 404;
    throw err;
  }

  cachedTenantRoleRefs = {
    companyId: companyRole.companyId,
    roleId: companyRole.roleId,
    role: companyRole.role,
  };

  return cachedTenantRoleRefs;
}

async function buildHOATenantUserFilter(extra = {}) {
  const refs = await getHOATenantRoleRefs();
  return buildCompanyRoleUserFilter(
    { companyId: refs.companyId, companyRoleId: refs.roleId },
    extra
  );
}

async function assignHOATenantRoleFields(userFields, options = {}) {
  const refs = await getHOATenantRoleRefs(options);
  userFields.companyId = refs.companyId;
  userFields.companyRoleId = refs.roleId;
  return userFields;
}

/**
 * is Tenant User Record
 *
 * Performs logic operations for isTenantUserRecord.
 *
 * @param user - Request/input argument
 * @param refs - Request/input argument
 * @returns Operations result
 */
function isTenantUserRecord(user, refs) {
  if (!user || !refs?.companyId || !refs?.roleId) return false;
  const toId = (id) => (id?.toString ? id.toString() : String(id));
  return toId(user.companyId) === toId(refs.companyId)
    && toId(user.companyRoleId) === toId(refs.roleId);
}

/**
 * clear H O A Tenant Role Cache
 *
 * Performs logic operations for clearHOATenantRoleCache.
 *
 * @returns Operations result
 */
function clearHOATenantRoleCache() {
  cachedTenantRoleRefs = null;
}

module.exports = {
  getHOATenantRoleRefs,
  buildHOATenantUserFilter,
  assignHOATenantRoleFields,
  isTenantUserRecord,
  clearHOATenantRoleCache,
};
