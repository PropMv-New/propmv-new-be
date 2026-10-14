const { ROLE_NAMES } = require('../constants/roleNames');
const {
  getCompanyRoleByName,
  getPropMvCompany,
  buildCompanyRoleUserFilter,
} = require('./companyRoleHelper');

let cachedVendorRoleRefs = null;
let cachedVendorRoleRefsAt = 0;
const VENDOR_ROLE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isVendorRole(role) {
  if (!role) return false;
  const name = typeof role === 'object' && role !== null && role.name ? String(role.name) : String(role);
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return n === 'vendor' || n === 'hoa vendor' || n === 'hoa_vendor';
}

async function getVendorRoleRefs(options = {}) {
  const cacheExpired = (Date.now() - cachedVendorRoleRefsAt) > VENDOR_ROLE_CACHE_TTL_MS;
  if (cachedVendorRoleRefs && !options.refresh && !cacheExpired) return cachedVendorRoleRefs;

  const companyRole = await getCompanyRoleByName(ROLE_NAMES.VENDOR, null, { ...options, refresh: true });
  if (!companyRole) {
    const err = new Error('Vendor role not found in company');
    err.status = 500;
    throw err;
  }

  cachedVendorRoleRefs = {
    companyId: companyRole.companyId,
    roleId: companyRole.roleId,
    role: companyRole.role,
  };
  cachedVendorRoleRefsAt = Date.now();

  return cachedVendorRoleRefs;
}

async function getVendorRole() {
  const refs = await getVendorRoleRefs();
  return {
    _id: refs.roleId,
    name: refs.role.name,
    description: refs.role.description,
    companyId: refs.companyId,
    source: 'company',
  };
}

async function getVendorRoleId() {
  const refs = await getVendorRoleRefs();
  return refs.roleId;
}

async function buildVendorUserFilter(extra = {}) {
  const refs = await getVendorRoleRefs();
  return buildCompanyRoleUserFilter(
    { companyId: refs.companyId, companyRoleId: refs.roleId },
    extra
  );
}

async function assignVendorRoleFields(userFields, options = {}) {
  const refs = await getVendorRoleRefs(options);
  userFields.companyId = refs.companyId;
  userFields.companyRoleId = refs.roleId;
  return userFields;
}

function clearVendorRoleCache() {
  cachedVendorRoleRefs = null;
  cachedVendorRoleRefsAt = 0;
}

module.exports = {
  isVendorRole,
  getVendorRole,
  getVendorRoleId,
  getVendorRoleRefs,
  buildVendorUserFilter,
  assignVendorRoleFields,
  clearVendorRoleCache,
  getPropMvCompany,
};
