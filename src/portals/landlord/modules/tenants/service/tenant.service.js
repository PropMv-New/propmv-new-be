/**
 * ------------------------------------------------------------------
 * File: tenant.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * tenant.controller, tenantExport.service
 * ------------------------------------------------------------------
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const path = require('path');
const logger = require('../../../../../common/logger');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * Lease wizards send client-temp tenant keys (e.g. Date.now()) on generatedInvoices /
 * insuranceTenantsIds. Split rows are remapped via `key` → real user _id; apply the same
 * map here so lease activation can cast invoice.tenants to ObjectId.
 */
function remapLeaseTenantClientKeys(leaseData, keyToUserIdMap) {
  if (!leaseData || !keyToUserIdMap || typeof keyToUserIdMap !== 'object') return leaseData;

  if (Array.isArray(leaseData.generatedInvoices)) {
    leaseData.generatedInvoices = leaseData.generatedInvoices.map((inv) => {
      if (!inv || inv.tenantId == null) return inv;
      const key = String(inv.tenantId);
      const mapped = keyToUserIdMap[key];
      if (!mapped) return inv;
      return { ...inv, tenantId: String(mapped) };
    });
  }

  if (Array.isArray(leaseData.insuranceTenantsIds)) {
    leaseData.insuranceTenantsIds = leaseData.insuranceTenantsIds.map((id) => {
      const key = String(id);
      return keyToUserIdMap[key] ? String(keyToUserIdMap[key]) : key;
    });
  }

  return leaseData;
}
const User = require('../../../../../shared/modules/users/models/user.model');
const Company = require('../../../../../shared/modules/company/models/company.model');
const { decryptIfEnabled } = require('../../../../../common/helpers/cryptoHelper');
const { validatePassword } = require('../../../../../common/helpers/validationHelper');
const { UPLOAD_TENANT_SUBDIR } = require('../../../../../common/constants/uploads');
const { USER_STATUSES } = require('../../../../../common/constants/user');
const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const { COMPANY_NAME } = require('../../../../../common/constants/company');
const { ROLE_NAMES } = require('../../../../../common/constants/roleNames');
const portalInvitationService = require('../../../../../shared/modules/auth/services/portalInvitation.service');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const { isValidInternationalPhone } = require('../../../../../shared/utils/phoneValidation.util');
const {
  assertUniqueUserEmail,
  assertUniqueUserPhone,
  DUPLICATE_EMAIL_MESSAGE,
} = require('../../../../../shared/modules/users/helpers/userIdentityValidation');
const {
  buildUserOwnerFilter,
  findPropertyIdsByCreatedBy,
  requireCreatedBy,
  resolveCreatedBy,
} = require('../../../../../shared/utils/creatorScope.util');
const { runInTransaction, withTenantTransaction, applySession } = require('./tenantDb.util');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { parseAppYmd } = require('../../../../../common/helpers/hoaBillingDates');

/**
 * Helper function to find Tenant role from company-based roles
 * @param {Object} creatorUser - The user creating the tenant (landlord/PM)
 * @param {Object} session - Mongoose session for transaction
 * @returns {Object|null} - { companyId, roleId } or null
 */
async function findTenantRoleFromCompany(creatorUser, session) {
  if (!creatorUser || !creatorUser.companyId) {
    logger.warn('⚠️ Creator user has no company - cannot find Tenant role');
    return null;
  }

  const company = await applySession(
    Company.findOne({ _id: toObjectId(creatorUser.companyId), isDeleted: { $ne: true } }),
    session
  );

  if (!company || !company.roles) {
    logger.warn(`⚠️ Company ${creatorUser.companyId} not found or has no roles`);
    return null;
  }

  const tenantRole = company.roles.find(
    r => r.name === 'Tenant' && r.isActive
  );

  if (!tenantRole) {
    logger.warn(`⚠️ Tenant role not found in company ${company._id}`);
    return null;
  }

  return {
    companyId: company._id,
    roleId: tenantRole._id,
  };
}

/**
 * Get all companies with active Tenant role for query building
 * @returns {Array} - Array of { companyId, roleId } objects
 */
async function getAllCompaniesWithTenantRole() {
  const companies = await Company.find({ isDeleted: { $ne: true } }).lean();
  const result = [];

  for (const company of companies) {
    if (company.roles) {
      const tenantRole = company.roles.find(r => r.name === 'Tenant' && r.isActive);
      if (tenantRole) {
        result.push({
          companyId: company._id,
          roleId: tenantRole._id,
        });
      }
    }
  }

  return result;
}

async function userHasTenantRole(user, session) {
  if (!user?.companyId || !user?.companyRoleId) return false;
  const company = await applySession(
    Company.findOne({ _id: toObjectId(user.companyId), isDeleted: { $ne: true } }),
    session
  );
  if (!company?.roles) return false;
  const userCompanyRole = company.roles.find(
    (r) => r._id.toString() === user.companyRoleId.toString() && r.isActive
  );
  return !!(userCompanyRole && userCompanyRole.name === 'Tenant');
}

async function assertUserHasTenantRole(user, session) {
  const isTenant = await userHasTenantRole(user, session);
  if (!isTenant) {
    const err = new Error(DUPLICATE_EMAIL_MESSAGE);
    err.status = 409;
    err.field = 'email';
    throw err;
  }
}

// Small helper to escape CSV values. Kept in service layer for reuse by CSV export functions.
function csvEscape(val) {
  if (val === null || typeof val === 'undefined') return '';
  const s = String(val);
  if (s.indexOf('"') !== -1) return '"' + s.replace(/"/g, '""') + '"';
  if (s.indexOf(',') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) return '"' + s + '"';
  return s;
}

/**
 * get Creator Id From Property
 *
 * Performs logic operations for getCreatorIdFromProperty.
 *
 * @param property - Request/input argument
 * @returns Operations result
 */
function getCreatorIdFromProperty(property) {
  return resolveCreatedBy(property);
}

/**
 * normalize Tenant Comparable Value
 *
 * Performs logic operations for normalizeTenantComparableValue.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function normalizeTenantComparableValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

/**
 * normalize Screening Array
 *
 * Performs logic operations for normalizeScreeningArray.
 *
 * @param screening - Request/input argument
 * @returns Operations result
 */
function normalizeScreeningArray(screening) {
  if (!Array.isArray(screening)) return [];
  return [...screening].map(String).sort();
}

/**
 * screening Arrays Equal
 *
 * Performs logic operations for screeningArraysEqual.
 *
 * @param left - Request/input argument
 * @param right - Request/input argument
 * @returns Operations result
 */
function screeningArraysEqual(left = [], right = []) {
  const a = normalizeScreeningArray(left);
  const b = normalizeScreeningArray(right);
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * build Tenant Profile From Payload
 *
 * Performs logic operations for buildTenantProfileFromPayload.
 *
 * @param tData - Request/input argument
 * @returns Operations result
 */
function buildTenantProfileFromPayload(tData = {}) {
  const createdBy = resolveCreatedBy(tData);
  return {
    email: tData.email ? String(tData.email).toLowerCase() : null,
    phone: normalizeTenantComparableValue(tData.phone),
    firstName: normalizeTenantComparableValue(tData.firstName),
    lastName: normalizeTenantComparableValue(tData.lastName),
    address: normalizeTenantComparableValue(tData.address),
    state: normalizeTenantComparableValue(tData.state),
    zipCode: normalizeTenantComparableValue(tData.zipCode),
    screening: normalizeScreeningArray(tData.screening),
    createdBy: createdBy ? String(createdBy) : null,
  };
}

/**
 * build Tenant Profile From User
 *
 * Performs logic operations for buildTenantProfileFromUser.
 *
 * @param user - Request/input argument
 * @returns Operations result
 */
function buildTenantProfileFromUser(user) {
  const doc = user && typeof user.toObject === 'function' ? user.toObject() : user || {};
  return {
    email: doc.email ? String(doc.email).toLowerCase() : null,
    phone: normalizeTenantComparableValue(doc.phone),
    firstName: normalizeTenantComparableValue(doc.firstName),
    lastName: normalizeTenantComparableValue(doc.lastName),
    address: normalizeTenantComparableValue(doc.address),
    state: normalizeTenantComparableValue(doc.state),
    zipCode: normalizeTenantComparableValue(doc.zipCode),
    screening: normalizeScreeningArray(doc.screening),
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
  };
}

/**
 * tenant Profiles Equal
 *
 * Performs logic operations for tenantProfilesEqual.
 *
 * @param left - Request/input argument
 * @param right - Request/input argument
 * @returns Operations result
 */
function tenantProfilesEqual(left, right) {
  const keys = ['email', 'phone', 'firstName', 'lastName', 'address', 'state', 'zipCode', 'createdBy'];
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return screeningArraysEqual(left.screening, right.screening);
}

/**
 * build Tenant Update Set From Profile
 *
 * Performs logic operations for buildTenantUpdateSetFromProfile.
 *
 * @param profile - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function buildTenantUpdateSetFromProfile(profile, { forceUndelete = false } = {}) {
  const setData = {
    phone: profile.phone,
    firstName: profile.firstName,
    lastName: profile.lastName,
    address: profile.address,
    state: profile.state,
    zipCode: profile.zipCode,
    screening: profile.screening,
    createdBy: profile.createdBy,
  };
  if (forceUndelete) setData.isDeleted = false;
  return setData;
}

/**
 * Reuse an existing tenant: update only when payload fields differ (or user was soft-deleted).
 */
async function reuseExistingTenantFromPayload(existingUser, tData, session) {
  if (!existingUser) {
    const err = new Error('Existing tenant record is required');
    err.status = 400;
    throw err;
  }

  await assertUserHasTenantRole(existingUser, session);

  const incoming = buildTenantProfileFromPayload(tData);
  const current = buildTenantProfileFromUser(existingUser);

  if (incoming.phone && incoming.phone !== current.phone) {
    await assertUniqueUserPhone(incoming.phone, existingUser._id, session);
  }
  const needsUndelete = existingUser.isDeleted === true;

  if (!needsUndelete && tenantProfilesEqual(current, incoming)) {
    logger.info(`  ✓ Existing tenant unchanged (${incoming.email || existingUser._id}), skipping update`);
    return existingUser;
  }

  const setData = buildTenantUpdateSetFromProfile(incoming, { forceUndelete: needsUndelete });
  const filter = needsUndelete
    ? { _id: existingUser._id }
    : { _id: existingUser._id, isDeleted: { $ne: true } };

  const updated = await User.findOneAndUpdate(filter, { $set: setData }, { new: true, session });
  if (!updated) {
    const err = new Error(`Tenant with ID ${existingUser._id} not found`);
    err.status = 404;
    throw err;
  }

  logger.info(`  ✓ Existing tenant updated (${incoming.email || existingUser._id})`);
  return updated;
}

/**
 * Create a tenant user with company-based role.
 * Tenant is assigned to the same company as the creator (landlord/property manager).
 * options may include { session }
 */
async function createTenantInSession(userData, session) {
  // Get creator's company info to assign tenant to same company
  const createdBy = requireCreatedBy(userData);
  const creatorUser = await applySession(
    User.findById(createdBy).select('companyId role'),
    session
  );

  if (!creatorUser) {
    const err = new Error('Creator user not found');
    err.status = 400;
    throw err;
  }

  if (!creatorUser.companyId) {
    const err = new Error('Creator user has no company - cannot assign Tenant role');
    err.status = 400;
    throw err;
  }

  const Company = require('../../../../../shared/modules/company/models/company.model');
  const company = await applySession(
    Company.findOne({ _id: toObjectId(creatorUser.companyId), isDeleted: { $ne: true } }),
    session
  );

  if (!company?.roles) {
    const err = new Error(`Company ${creatorUser.companyId} not found or has no roles`);
    err.status = 404;
    throw err;
  }

  const tenantRole = company.roles.find((r) => r.name === 'Tenant' && r.isActive);
  if (!tenantRole) {
    const err = new Error(`Tenant role not found in company ${company._id}`);
    err.status = 404;
    throw err;
  }

  const tenantCompanyId = company._id;
  const tenantCompanyRoleId = tenantRole._id;
  logger.info(`  ✓ Assigning tenant to company ${company._id} with role ${tenantRole._id}`);

  await assertUniqueUserEmail(userData.email, null, session);
  if (userData.phone) {
    await assertUniqueUserPhone(userData.phone, null, session);
  }

  let plainPassword;
  try {
    plainPassword = decryptIfEnabled(userData.password);
  } catch (e) {
    const err = new Error('Failed to decrypt password');
    err.status = 400;
    throw err;
  }

  const hashed = await bcrypt.hash(plainPassword, 10);
  const userFields = {
    email: userData.email,
    password: hashed,
    phone: userData.phone || null,
    firstName: userData.firstName || null,
    lastName: userData.lastName || null,
    address: userData.address || null,
    state: userData.state || null,
    zipCode: userData.zipCode || null,
    createdBy,
    screening: userData.screening || [],
    status: USER_STATUSES.PENDING,
  };

  userFields.companyId = tenantCompanyId;
  userFields.companyRoleId = tenantCompanyRoleId;

  try {
    if (session) {
      const docs = await User.create([userFields], { session });
      return docs[0];
    }
    return User.create(userFields);
  } catch (e) {
    if (e && e.code === 11000) {
      const err = new Error('Email already exists');
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

async function createTenant(userData, options = {}) {
  return withTenantTransaction((session) => createTenantInSession(userData, session), options);
}

module.exports = {
  createTenant,
};

/**
 * Update an existing tenant user.
 * tenantId - string id of the user
 * tenantData - fields to update (may include password)
 * options - may include { session }
 */
async function updateTenantInSession(tenantId, tenantData, session) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }

  const findQuery = { _id: toObjectId(tenantId), isDeleted: { $ne: true } };
  const existing = await applySession(User.findOne(findQuery), session);
  if (!existing) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const updateFields = {};

  if (tenantData.email && tenantData.email !== existing.email) {
    await assertUniqueUserEmail(tenantData.email, tenantId, session);
    updateFields.email = tenantData.email;
  }

  if (
    tenantData.phone &&
    tenantData.phone !== existing.phone
  ) {
    await assertUniqueUserPhone(tenantData.phone, tenantId, session);
  }

  if (tenantData.password) {
    let plain;
    try {
      plain = decryptIfEnabled(tenantData.password);
    } catch (e) {
      const err = new Error('Failed to decrypt password');
      err.status = 400;
      throw err;
    }
    const pwdValidation2 = validatePassword(plain);
    if (!pwdValidation2.isValid) {
      const err = new Error(pwdValidation2.errors.join('; '));
      err.status = 400;
      throw err;
    }
    updateFields.password = await bcrypt.hash(plain, 10);
  }

  const allowed = ['phone', 'firstName', 'lastName', 'address', 'city', 'state', 'zipCode', 'screening'];
  allowed.forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(tenantData, k)) {
      updateFields[k] = tenantData[k] || null;
    }
  });

  // Check if user is a tenant by checking company-based role
  let isTenantUser = false;
  if (existing.companyId && existing.companyRoleId) {
    const company = await applySession(
      Company.findOne({ _id: existing.companyId, isDeleted: { $ne: true } }),
      session
    );
    if (company && company.roles) {
      const userRole = company.roles.find(
        r => r._id.toString() === existing.companyRoleId.toString() && r.isActive
      );
      isTenantUser = userRole && userRole.name === 'Tenant';
    }
  }

  if (isTenantUser) {
    if (Object.prototype.hasOwnProperty.call(tenantData, 'createdBy')) {
      const createdBy = requireCreatedBy(tenantData);
      const ownerUser = await applySession(
        User.findOne({ _id: toObjectId(createdBy), isDeleted: { $ne: true } }),
        session
      );
      if (!ownerUser) {
        const err = new Error('owner user not found');
        err.status = 400;
        throw err;
      }
      updateFields.createdBy = createdBy;
    } else if (!resolveCreatedBy(existing)) {
      const err = new Error('createdBy is required for tenant users');
      err.status = 400;
      throw err;
    }
  }

  if (Object.keys(updateFields).length === 0) {
    return existing;
  }

  const opts = { new: true };
  if (session) opts.session = session;

  return User.findOneAndUpdate({ _id: toObjectId(tenantId), isDeleted: { $ne: true } }, { $set: updateFields }, opts);
}

async function updateTenant(tenantId, tenantData, options = {}) {
  return withTenantTransaction((session) => updateTenantInSession(tenantId, tenantData, session), options);
}

// augment exports
module.exports = Object.assign(module.exports, { updateTenant });

/**
 * List tenants with pagination. Accepts a filter object and pagination parameters.
 * @param {Object} filter - Filter parameters (createdBy required)
 * @param {Object} pagination - Pagination parameters (pageNumber, pageSize)
 * @returns {Promise<{data: Array, total: number, page: number, pageSize: number}>}
 */
async function listTenants(filter = {}, { pageNumber, pageSize } = {}) {
  const createdBy = requireCreatedBy(filter);

  const ownerUser = await User.findOne({ _id: toObjectId(createdBy), isDeleted: { $ne: true } });
  if (!ownerUser) {
    const err = new Error('owner user not found'); err.status = 400; throw err;
  }

  // Build query to support company-based roles only
  const companiesWithTenantRole = await getAllCompaniesWithTenantRole();

  if (companiesWithTenantRole.length === 0) {
    logger.warn('⚠️ No companies with Tenant role found');
    return {
      data: [],
      total: 0,
      page: pageNumber || 1,
      pageSize: pageSize || 10
    };
  }

  // Build OR query for all company-tenant role combinations
  const roleQuery = {
    $or: companiesWithTenantRole.map(({ companyId, roleId }) => ({
      companyId,
      companyRoleId: roleId
    }))
  };

  const q = { ...roleQuery, isDeleted: { $ne: true }, ...buildUserOwnerFilter(createdBy) };

  const { createdBy: _dropCreatedBy, search, ...rest } = filter || {};
  const safeRest = {};
  if (rest._id !== undefined) safeRest._id = toObjectId(rest._id);
  if (search) {
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'i');
    safeRest.$or = [{ firstName: re }, { lastName: re }, { email: re }];
  }
  Object.assign(q, safeRest);

  // Get standardized pagination parameters
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pageNumber,
    pageSize
  });

  // Execute paginated query
  const [users, total] = await Promise.all([
    User.find(q)
      .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -mfaOtp -mfaOtpExpiresAt -mfaOtpAction -refreshToken')
      .skip(offset)
      .limit(effectiveLimit)
      .lean(),
    User.countDocuments(q)
  ]);

  return {
    data: users,
    total,
    page,
    pageSize: effectivePageSize
  };
}

/**
 * Get a tenant by id
 */
async function getTenantById(tenantId) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }
  const user = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } })
    .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -mfaOtp -mfaOtpExpiresAt -mfaOtpAction -refreshToken');
  if (!user) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }
  return user;
}

/**
 * Get a tenant by email
 * Only returns users with Tenant role from PropMv company
 * If user exists with email but is not a tenant, throws an error
 */
async function getTenantByEmail(email) {
  if (!email) {
    const err = new Error('email is required');
    err.status = 400;
    throw err;
  }

  // First, check if any user exists with this email
  const anyUser = await User.findOne({
    email: String(email).trim().toLowerCase(),
    isDeleted: { $ne: true }
  })
    .select('_id companyId companyRoleId')
    .lean();

  // If user exists, check if they are a tenant using company-based role
  if (anyUser) {
    let isTenant = false;

    // Check company-based role system
    if (anyUser.companyId && anyUser.companyRoleId) {
      const company = await Company.findOne({ _id: toObjectId(anyUser.companyId), isDeleted: { $ne: true } }).lean();
      if (company && company.roles) {
        const userCompanyRole = company.roles.find(
          r => r._id.toString() === anyUser.companyRoleId.toString() && r.isActive
        );
        if (userCompanyRole && userCompanyRole.name === 'Tenant') {
          isTenant = true;
        }
      }
    }

    // If user exists but is not a tenant, throw error
    if (!isTenant) {
      const err = new Error(DUPLICATE_EMAIL_MESSAGE);
      err.status = 409;
      err.field = 'email';
      throw err;
    }
  }

  // Query user with tenant role from company-based roles
  const companiesWithTenantRole = await getAllCompaniesWithTenantRole();

  if (companiesWithTenantRole.length === 0) {
    return null;
  }

  const roleQuery = {
    $or: companiesWithTenantRole.map(({ companyId, roleId }) => ({
      companyId,
      companyRoleId: roleId
    }))
  };

  const user = await User.findOne({
    email: email,
    ...roleQuery,
    isDeleted: { $ne: true }
  })
    .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -mfaOtp -mfaOtpExpiresAt -mfaOtpAction -refreshToken');

  // Return null if user not found instead of throwing error
  return user || null;
}

module.exports = Object.assign(module.exports, { listTenants, getTenantById, getTenantByEmail });

/**
 * Get tenant names for filter dropdown - returns only id and name for tenants with leases
 */
async function getTenantNames(createdBy, searchText = '') {
  const Lease = require('../../leasing/model/lease.model');
  const Property = require('../../property/model/property.model');
  const { findPropertyIdsByCreatedBy } = require('../../../../../shared/utils/creatorScope.util');

  const ownerId = requireCreatedBy({ createdBy });
  const propertyIds = await findPropertyIdsByCreatedBy(Property, ownerId);
  if (!propertyIds.length) return [];

  const leases = await Lease.find({
    property_id: { $in: propertyIds },
    isDeleted: { $ne: true },
  })
    .select('rentAndDepositDestribution.split.tenantId')
    .lean();

  const tenantIds = new Set();
  leases.forEach(lease => {
    if (lease.rentAndDepositDestribution?.split) {
      lease.rentAndDepositDestribution.split.forEach(split => {
        if (split.tenantId) tenantIds.add(split.tenantId.toString());
      });
    }
  });

  const query = {
    _id: { $in: Array.from(tenantIds) },
    isDeleted: { $ne: true },
    ...buildUserOwnerFilter(ownerId),
  };

  if (searchText) {
    query.$or = [
      { firstName: { $regex: searchText, $options: 'i' } },
      { lastName: { $regex: searchText, $options: 'i' } }
    ];
  }

  const tenants = await User.find(query)
    .select('_id firstName lastName')
    .limit(4)
    .lean();

  return tenants.map(t => ({
    id: t._id,
    name: `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'N/A'
  }));
}

module.exports = Object.assign(module.exports, { getTenantNames });

/**
 * Soft-delete a tenant by setting isDeleted = true
 */
async function deleteTenantInSession(tenantId, session) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }

  const opts = { new: true };
  if (session) opts.session = session;

  const updated = await User.findOneAndUpdate(
    { _id: toObjectId(tenantId), isDeleted: { $ne: true } },
    { isDeleted: true },
    opts
  );

  if (!updated) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  return updated;
}

async function deleteTenant(tenantId, options = {}) {
  return withTenantTransaction((session) => deleteTenantInSession(tenantId, session), options);
}

module.exports = Object.assign(module.exports, { deleteTenant });

/**
 * Add uploaded documents metadata to tenant's documents array
 * uploaded: [{ key, url, originalName }]
 */
async function addDocumentsToTenantInSession(tenantId, uploaded, session) {
  const docsToAdd = uploaded.map((u) => ({ metadataId: u.metadataId }));
  const opts = { new: true };
  if (session) opts.session = session;

  const updated = await User.findOneAndUpdate(
    { _id: tenantId, isDeleted: { $ne: true } },
    { $push: { documents: { $each: docsToAdd } } },
    opts
  );

  if (!updated) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const obj = updated.toObject ? updated.toObject() : updated;
  delete obj.password;
  return obj;
}

async function addDocumentsToTenantService(tenantId, uploaded = [], options = {}) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(uploaded) || uploaded.length === 0) {
    const err = new Error('No uploaded files provided');
    err.status = 400;
    throw err;
  }

  return withTenantTransaction(
    (session) => addDocumentsToTenantInSession(tenantId, uploaded, session),
    options
  );
}

module.exports = Object.assign(module.exports, { addDocumentsToTenantService });

/**
 * Setup a tenant and create a lease transactionally.
 * Accepts payload: { tenant: { ... }, lease: { ... } } or legacy where tenant fields are at root and lease under `lease`.
 * Returns { tenant, lease } where tenant has password removed.
 */
async function setupTenant(payload = {}, options = {}) {
  // Check if we should skip sending invite emails (used when sending application emails instead)
  const skipInviteEmail = options.skipInviteEmail === true;

  const body = payload || {};
  const tenantsData = Array.isArray(body.tenants) ? body.tenants : [];
  const leaseData = body.lease;

  if (!Array.isArray(tenantsData) || tenantsData.length === 0) {
    const err = new Error('tenants array is required and must contain at least one tenant');
    err.status = 400;
    throw err;
  }
  if (!leaseData) {
    const err = new Error('lease payload is required in request body as `lease`');
    err.status = 400;
    throw err;
  }

  const SECRET_FIELD = 'passphrase';
  const anyInviteOnlyTenant = tenantsData.some(
    (t) => !t || !t[SECRET_FIELD] || (typeof t[SECRET_FIELD] === 'string' && t[SECRET_FIELD].trim() === '')
  );
  if (anyInviteOnlyTenant && !options.inviterUserId) {
    const err = new Error('Authenticated landlord context is required to send tenant invitations.');
    err.status = 400;
    throw err;
  }
  // Note: removed strict role assertion to allow Administrators or other privileged
  // system actors to send application invitations. Authorization should be enforced
  // at the route/privilege level (middleware) rather than hard-coded here.

  // Validate property early
  if (!leaseData.property_id) {
    const err = new Error('lease.property_id is required'); err.status = 400; throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(leaseData.property_id))) {
    const err = new Error('lease.property_id must be a valid ObjectId'); err.status = 400; throw err;
  }
  const Property = require('../../property/model/property.model');
  const propertyExists = await Property.findOne({ _id: toObjectId(leaseData.property_id), isDeleted: { $ne: true } }).lean();
  if (!propertyExists) {
    const err = new Error('property not found'); err.status = 400; throw err;
  }
  const createdByFromProperty = getCreatorIdFromProperty(propertyExists);
  if (!createdByFromProperty) { const err = new Error('property is not associated with an owner'); err.status = 400; throw err; }

  const persistSetup = async (session) => {
    // Create/Update tenants sequentially under the same session
    // We keep a local map of provided tenant keys to tenant IDs so rent split entries
    // can reference tenants by key
    const createdTenants = [];
    const createdTenantKeyMap = {}; // key => id
    for (const tData of tenantsData) {
      // enforce presence of explicit key in tenant object
      if (!tData || !tData.key) {
        const err = new Error('each tenant must include an explicit `key` field');
        err.status = 400;
        throw err;
      }
      const providedKey = String(tData.key);
      // ensure no duplicate keys in the same payload
      if (createdTenantKeyMap[providedKey]) {
        const err = new Error(`duplicate tenant key in payload: ${providedKey}`);
        err.status = 400;
        throw err;
      }

      // Enforce request-level validation: each tenant object must include email
      if (!tData.email) {
        const err = new Error("Without an email address, you will be unable to send documents to be signed, request renter's insurance, or collect payments online. Are you sure you'd like to proceed?"); err.status = 400; throw err;
      }
      // validate email format
      const { isValidEmail } = require('../../../../../common/helpers/validationHelper');
      if (!isValidEmail(tData.email)) {
        const err = new Error('tenant email must be a valid email address'); err.status = 400; throw err;
      }

      // Phone is now optional - only validate if provided
      if (tData.phone) {
        // Accept international phone numbers with 7-15 digits
        if (!isValidInternationalPhone(tData.phone)) {
          const err = new Error('tenant phone must be a valid phone number (7-15 digits, country code allowed)'); err.status = 400; throw err;
        }
      }

      if (!resolveCreatedBy(tData)) tData.createdBy = createdByFromProperty;

      // Ensure email is lowercase for consistent lookups
      if (tData.email) {
        tData.email = tData.email.toLowerCase();
      }

      let userRecord;

      // Check if userId is provided (user already exists and prefilled in UI)
      if (tData.userId && mongoose.Types.ObjectId.isValid(String(tData.userId))) {
        logger.info(`✏️ Reusing existing user with ID: ${tData.userId}`);
        const existingById = await User.findOne({ _id: tData.userId }).session(session);
        if (!existingById) {
          const err = new Error(`User with ID ${tData.userId} not found`);
          err.status = 404;
          throw err;
        }
        userRecord = await reuseExistingTenantFromPayload(existingById, tData, session);
      } else {
        // No userId provided - check if user exists by email first
        // IMPORTANT: Use session for consistency within the transaction
        let existingUserByEmail = await User.findOne({ email: tData.email, isDeleted: { $ne: true } }).session(session);

        // If not found with active check, try without isDeleted filter to catch soft-deleted users
        if (!existingUserByEmail) {
          existingUserByEmail = await User.findOne({ email: tData.email }).session(session);
        }

        if (existingUserByEmail) {
          logger.info(`Found existing user with email: ${tData.email}, reusing`);
          userRecord = await reuseExistingTenantFromPayload(existingUserByEmail, tData, session);
        } else {
          // Create new user
          logger.info(`📝 Creating new tenant with email: ${tData.email}`);

          const hasPasswordInput = tData.passphrase != null && String(tData.passphrase).trim() !== '';
          let rawSecret = null;
          let usePortalInvite = !hasPasswordInput;

          if (hasPasswordInput) {
            try {
              rawSecret = decryptIfEnabled(tData.passphrase);
            } catch (e) {
              const err = new Error('Failed to decrypt passphrase');
              err.status = 400;
              throw err;
            }
            if (rawSecret == null || String(rawSecret).trim() === '') {
              usePortalInvite = true;
            }
          }
          if (usePortalInvite) {
            rawSecret = crypto.randomBytes(48).toString('base64url');
          }

          const hashed = await bcrypt.hash(rawSecret, 10);

          // Get creator's company info to assign tenant to same company
          const creatorUserId = requireCreatedBy(tData);
          const creatorUser = await User.findById(creatorUserId).select('companyId role').session(session);

          if (!creatorUser) {
            const err = new Error('Creator user not found');
            err.status = 400;
            throw err;
          }

          let tenantCompanyId = null;
          let tenantCompanyRoleId = null;
          let tenantRoleId = null; // Fallback for old system

          // If creator has company-based role, assign tenant to same company
          if (creatorUser.companyId) {
            const Company = require('../../../../../shared/modules/company/models/company.model');
            const company = await Company.findOne({ _id: creatorUser.companyId, isDeleted: { $ne: true } }).session(session);

            if (company && company.roles) {
              // Find Tenant role in company's embedded roles
              const tenantRole = company.roles.find(
                r => r.name === 'Tenant' && r.isActive
              );

              if (tenantRole) {
                tenantCompanyId = company._id;
                tenantCompanyRoleId = tenantRole._id;
                logger.info(`  ✓ Assigning tenant to company ${company._id} with role ${tenantRole._id}`);
              } else {
                logger.warn(`  ⚠ Tenant role not found in company ${company._id}, falling back to old role system`);
              }
            }
          }

          // Fallback to old role collection if company role not found
          if (!tenantCompanyRoleId) {
            const err = new Error('Tenant role not found in company. Cannot create tenant without company-based role.');
            err.status = 404;
            throw err;
          }

          const userFields = {
            email: tData.email,
            password: hashed,
            phone: tData.phone || null,
            firstName: tData.firstName || null,
            lastName: tData.lastName || null,
            address: tData.address || null,
            state: tData.state || null,
            zipCode: tData.zipCode || null,
            createdBy: requireCreatedBy(tData),
            screening: tData.screening || [],
            status: USER_STATUSES.PENDING,
          };

          // Assign company-based role (required)
          if (tenantCompanyId && tenantCompanyRoleId) {
            userFields.companyId = tenantCompanyId;
            userFields.companyRoleId = tenantCompanyRoleId;
          } else {
            const err = new Error('Company and role assignment failed for tenant');
            err.status = 500;
            throw err;
          }

          if (usePortalInvite) {
            userFields.portalOnboardingStatus = PORTAL_ONBOARDING_STATUS.INVITATION_SENT;
          }

          await assertUniqueUserEmail(tData.email, null, session);
          if (tData.phone) {
            await assertUniqueUserPhone(tData.phone, null, session);
          }

          const docs = await User.create([userFields], { session });
          userRecord = docs[0];
          userRecord._portalInviteUsed = usePortalInvite;
          logger.info(`  ✓ New tenant created with ID: ${userRecord._id}`);
        }
      }

      createdTenants.push({ created: userRecord, key: providedKey });
      createdTenantKeyMap[providedKey] = String(userRecord._id || (userRecord.toObject ? userRecord.toObject()._id : ''));
    }

    // Build tenantId list (strings)
    const createdTenantIds = createdTenants.map((t) => String(t.created._id || (t.created.toObject ? t.created.toObject()._id : ''))).filter(Boolean);

    // Prepare rentAndDepositDestribution.split: REQUIRE that the client provides a non-empty split
    // and that the number of split entries equals the number of tenants in this request. Each split
    // item may reference a tenant by `tenantId` or by `key` (which maps to the `key` or email on a
    // tenant in this request). We will map keys to created tenant IDs and validate existence.
    if (!leaseData.rentAndDepositDestribution) leaseData.rentAndDepositDestribution = {};
    const rd = leaseData.rentAndDepositDestribution;

    // enforce presence
    if (!Array.isArray(rd.split) || rd.split.length === 0) {
      const err = new Error('rentAndDepositDestribution.split is required and must contain one entry per tenant');
      err.status = 400;
      throw err;
    }

    // enforce same count as tenants provided
    if (rd.split.length !== createdTenantIds.length) {
      const err = new Error('number of split entries must match number of tenants');
      err.status = 400;
      throw err;
    }

    // Map keys to ids where provided
    for (const s of rd.split) {
      if (s.key) {
        const k = String(s.key);
        if (createdTenantKeyMap[k]) {
          s.tenantId = createdTenantKeyMap[k];
        }
      }
    }

    remapLeaseTenantClientKeys(leaseData, createdTenantKeyMap);

    const { syncScreeningFromTenantsToSplit } = require('../../leasing/service/leaseTenantInviteDelivery.service');
    rd.split = syncScreeningFromTenantsToSplit(tenantsData, rd.split);
    leaseData.rentAndDepositDestribution = rd;

    // Resolve unit id + name (unitId preferred); validates against property.unitDetails
    const { resolveUnitForPropertyId } = require('../../../../../common/helpers/propertyUnitReference');
    const resolvedLeaseUnit = await resolveUnitForPropertyId(
      leaseData.property_id,
      { unitId: leaseData.unitId, unitName: leaseData.unitName },
      { session }
    );
    leaseData.unitId = resolvedLeaseUnit.unitId;
    leaseData.unitName = resolvedLeaseUnit.unitName;

    // Validate that referenced tenantIds exist (either created in this transaction or existing users)
    const referencedIds = rd.split.map((s) => s.tenantId ? String(s.tenantId) : null).filter(Boolean);
    if (referencedIds.length > 0) {
      // Check against created tenant IDs first (from this transaction)
      const allValidIds = new Set([...createdTenantIds, ...referencedIds]);

      // For any IDs not created in this transaction, verify they exist in database
      // IMPORTANT: Do NOT use .session(session) for this read - uncommitted writes in the transaction
      // are not visible to .session() queries in the same transaction
      const externalIds = referencedIds.filter(id => !createdTenantIds.includes(id));
      if (externalIds.length > 0) {
        const users = await User.find({ _id: { $in: externalIds }, isDeleted: { $ne: true } }).lean();
        const foundIds = users.map((u) => String(u._id));
        const missing = externalIds.filter((id) => !foundIds.includes(id));
        if (missing.length) {
          const err = new Error(`tenant user(s) not found: ${missing.join(', ')}`);
          err.status = 400;
          throw err;
        }
      }
    }

    // Coerce numeric fields to Number and normalize tenantId to string
    rd.split = rd.split.map((s) => {
      const out = Object.assign({}, s);
      if (out.rentAmount !== undefined) out.rentAmount = Number(out.rentAmount);
      if (out.rentPercentage !== undefined) out.rentPercentage = Number(out.rentPercentage);
      if (out.depositAmount !== undefined) out.depositAmount = Number(out.depositAmount);
      if (out.depositPercentage !== undefined) out.depositPercentage = Number(out.depositPercentage);
      if (out.tenantId) out.tenantId = String(out.tenantId);
      return out;
    });

    // Now create the lease under same session
    const leasingService = require('../../leasing/service/lease.service');
    let createdLease;
    try {
      logger.info('📋 Creating lease with data:', JSON.stringify({
        property_id: leaseData.property_id,
        leaseTerm: leaseData.leaseTerm,
        lease_type: leaseData.lease_type,
        start_date: leaseData.start_date,
        end_date: leaseData.end_date,
        splitCount: rd.split.length,
        tenantIds: rd.split.map(s => s.tenantId)
      }));
      // Normalize insurance fields coming from setup payload
      if (leaseData && typeof leaseData.requireInsurance !== 'boolean') {
        const v = leaseData.requireInsurance;
        leaseData.requireInsurance = (v === true || v === 'true' || v === '1' || v === 1 || v === 'on');
      }
      // Normalize includeDamageReport if present
      if (leaseData && typeof leaseData.includeDamageReport !== 'boolean') {
        const v3 = leaseData.includeDamageReport;
        leaseData.includeDamageReport = (v3 === true || v3 === 'true' || v3 === '1' || v3 === 1 || v3 === 'on');
      }
      if (leaseData && leaseData.insuranceTenantsIds && !Array.isArray(leaseData.insuranceTenantsIds)) {
        if (typeof leaseData.insuranceTenantsIds === 'string') {
          leaseData.insuranceTenantsIds = leaseData.insuranceTenantsIds.split(',').map(s => String(s).trim()).filter(Boolean);
        } else {
          leaseData.insuranceTenantsIds = [String(leaseData.insuranceTenantsIds)];
        }
      }
      createdLease = await leasingService.createLeaseService(leaseData, { session });
      logger.info('Lease created successfully with ID:', createdLease._id);

      const { seedLeaseTenantInviteAcksForLease } = require('../../leasing/service/leaseTenantInviteAck.service');
      await seedLeaseTenantInviteAcksForLease(createdLease, { session });
    } catch (leaseError) {
      logger.error(' Failed to create lease:', leaseError.message);
      logger.error('Stack:', leaseError.stack);
      throw leaseError;
    }

    return { createdTenants, createdLease, rd };
  };

  const dbResult = options.session
    ? await persistSetup(options.session)
    : await runInTransaction(persistSetup);

  const { createdTenants, createdLease, rd } = dbResult;

  // Prepare tenant safe payloads (remove passwords)
  const tenantsSafe = createdTenants.map(({ created, key }) => {
    const obj = created && created.toObject ? created.toObject() : (created || {});
    if (obj && obj.password) delete obj.password;
    if (obj && Object.prototype.hasOwnProperty.call(obj, '_portalInviteUsed')) delete obj._portalInviteUsed;
    if (key) obj.key = key;
    return obj;
  });

  // Send emails asynchronously in background if not skipped
  if (!skipInviteEmail) {
    setImmediate(async () => {
      try {
        const { sendLeaseTenantOnboardingEmails } = require('../../leasing/service/leaseTenantInviteDelivery.service');
        const leaseSplitForEmail =
          (createdLease &&
            createdLease.rentAndDepositDestribution &&
            Array.isArray(createdLease.rentAndDepositDestribution.split) &&
            createdLease.rentAndDepositDestribution.split) ||
          rd.split ||
          [];

        const emailSummary = await sendLeaseTenantOnboardingEmails({
          leaseId: String(createdLease._id),
          createdTenants,
          tenantsData,
          leaseSplit: leaseSplitForEmail,
          inviterUserId: options.inviterUserId,
        });

        if (emailSummary.failedCount > 0) {
          logger.warn(
            `[setupTenant] ${emailSummary.failedCount} onboarding email(s) failed for lease ${createdLease._id}`
          );
        } else {
          logger.info(`[setupTenant] All onboarding emails sent successfully for lease ${createdLease._id}`);
        }
      } catch (emailErr) {
        logger.error('[setupTenant] Onboarding email batch failed:', emailErr.message, emailErr.stack);
      }
    });
  } else {
    logger.info('ℹ️  Email sending skipped (will be sent separately)');
  }

  // Attach tenant info to lease split for response (read from DB after commit)
  const tenantIdsUsed = Array.isArray(rd.split) ? rd.split.map(s => s.tenantId).filter(Boolean) : [];
  if (tenantIdsUsed.length > 0) {
    try {
      const tenantUsers = await User.find({ _id: { $in: tenantIdsUsed }, isDeleted: { $ne: true } }).select('-password').lean();
      const userMap = tenantUsers.reduce((acc, u) => { acc[String(u._id)] = u; return acc; }, {});

      const leaseObj = createdLease && createdLease.toObject ? createdLease.toObject() : (createdLease || {});
      if (leaseObj && leaseObj.rentAndDepositDestribution && Array.isArray(leaseObj.rentAndDepositDestribution.split)) {
        leaseObj.rentAndDepositDestribution.split = leaseObj.rentAndDepositDestribution.split.map((sp) => {
          const out = Object.assign({}, sp);
          const tid = out.tenantId ? String(out.tenantId) : null;
          if (tid && userMap[tid]) {
            out.tenant = userMap[tid];
          } else {
            out.tenant = null;
          }
          return out;
        });
      }

      return { tenants: tenantsSafe, lease: leaseObj };
    } catch (attachErr) {
      logger.warn('Failed to attach tenant user info to lease split:', attachErr && attachErr.message);
    }
  }

  return { tenants: tenantsSafe, lease: createdLease };
}

module.exports = Object.assign(module.exports, { setupTenant });

/**
 * Update tenant setup and lease details transactionally.
 * Accepts payload: { tenant: { ... }, lease: { ... } } and tenantId.
 * Returns { tenant, lease } where tenant has password removed.
 */
async function updateTenantSetup(tenantId, payload = {}, options = {}) {
  if (!tenantId) {
    const err = new Error('tenantId is required');
    err.status = 400;
    throw err;
  }

  const persistUpdate = async (session) => {
    const body = payload || {};
    const tenantData = body.tenant || {};
    const leaseData = body.lease || {};

    let updatedTenant = null;
    if (Object.keys(tenantData).length > 0) {
      updatedTenant = await updateTenant(tenantId, tenantData, { session });
    } else {
      updatedTenant = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } }).session(session);
      if (!updatedTenant) {
        const err = new Error('Tenant not found');
        err.status = 404;
        throw err;
      }
    }

    let updatedLease = null;
    if (Object.keys(leaseData).length > 0 && leaseData.leaseId) {
      // Normalize damage report & insurance fields before updating
      if (leaseData && typeof leaseData.includeDamageReport !== 'boolean') {
        const v3 = leaseData.includeDamageReport;
        leaseData.includeDamageReport = (v3 === true || v3 === 'true' || v3 === '1' || v3 === 1 || v3 === 'on');
      }
      if (leaseData && typeof leaseData.requireInsurance !== 'boolean') {
        const v = leaseData.requireInsurance;
        leaseData.requireInsurance = (v === true || v === 'true' || v === '1' || v === 1 || v === 'on');
      }
      if (leaseData && leaseData.insuranceTenantsIds && !Array.isArray(leaseData.insuranceTenantsIds)) {
        if (typeof leaseData.insuranceTenantsIds === 'string') {
          leaseData.insuranceTenantsIds = leaseData.insuranceTenantsIds.split(',').map(s => String(s).trim()).filter(Boolean);
        } else {
          leaseData.insuranceTenantsIds = [String(leaseData.insuranceTenantsIds)];
        }
      }
      const leasingService = require('../../leasing/service/lease.service');
      updatedLease = await leasingService.updateLeaseService(leaseData.leaseId, leaseData, { session });
    }

    return { updatedTenant, updatedLease };
  };

  const dbResult = options.session
    ? await persistUpdate(options.session)
    : await runInTransaction(persistUpdate);

  const tenantSafe = dbResult.updatedTenant && dbResult.updatedTenant.toObject
    ? dbResult.updatedTenant.toObject()
    : (dbResult.updatedTenant || {});
  if (tenantSafe && tenantSafe.password) delete tenantSafe.password;

  return {
    tenant: tenantSafe,
    lease: dbResult.updatedLease,
  };
}

/**
 * Resend invitation email to a tenant for a given property.
 * Fetch tenant and property, resolve landlord, and send invite using emailHelper.
 */
async function resendInviteService(propertyId, tenantId) {
  if (!propertyId) { const err = new Error('propertyId is required'); err.status = 400; throw err; }
  if (!tenantId) { const err = new Error('tenantId is required'); err.status = 400; throw err; }
  if (!mongoose.Types.ObjectId.isValid(String(propertyId))) { const err = new Error('propertyId must be a valid ObjectId'); err.status = 400; throw err; }
  if (!mongoose.Types.ObjectId.isValid(String(tenantId))) { const err = new Error('tenantId must be a valid ObjectId'); err.status = 400; throw err; }

  const Property = require('../../property/model/property.model');
  const property = await Property.findOne({ _id: propertyId, isDeleted: { $ne: true } }).lean();
  if (!property) { const err = new Error('property not found'); err.status = 404; throw err; }

  const tenantUser = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } }).lean();
  if (!tenantUser) { const err = new Error('tenant user not found'); err.status = 404; throw err; }

  const createdBy = getCreatorIdFromProperty(property);
  if (!createdBy) { const err = new Error('property is not associated with an owner'); err.status = 400; throw err; }

  const landlordUser = await User.findOne({ _id: createdBy, isDeleted: { $ne: true } }).lean();
  const landlordName = landlordUser ? `${landlordUser.firstName || ''} ${landlordUser.lastName || ''}`.trim() || (landlordUser.email || 'Landlord') : 'Landlord';

  // prepare template data
  const data = {
    landlordName,
    appName: process.env.APP_NAME || 'propmv',
    inviteUrl: process.env.INVITE_ACCEPT_URL || process.env.INVITE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://www.google.com',
  };

  try {
    await emailHelper.sendEmail('invite', tenantUser.email, data, { template: 'invite' });
  } catch (e) {
    const err = new Error('Failed to send invite email: ' + (e && e.message ? e.message : String(e)));
    err.status = 500;
    throw err;
  }
}

module.exports = Object.assign(module.exports, { resendInviteService });

// Upload files to storage and persist mapping transactionally
async function uploadTenantDocuments(tenantId, files = [], userId = null) {
  logger.info('📤 uploadTenantDocuments called', { tenantId, fileCount: files.length, userId });

  if (!tenantId) {
    const err = new Error('tenant id is required'); err.status = 400; throw err;
  }
  if (!Array.isArray(files) || files.length === 0) {
    const err = new Error('No files provided'); err.status = 400; throw err;
  }

  const s3Client = require('../../../../../integrations/s3');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const config = require('../../../../../config/default');
  const s3Staged = [];
  try {
    logger.info('📁 Starting file uploads to S3...');
    for (const f of files) {
      const filename = f.filename || f.originalname;
      const key = s3Client.getKeyForTenant
        ? s3Client.getKeyForTenant(tenantId, filename, userId)
        : `${UPLOAD_TENANT_SUBDIR || 'tenants'}/${filename}`;
      logger.info(`  ⬆️  Uploading file: ${filename} with key: ${key}`);
      const result = await s3Client.upload({ localFilePath: f.path, key });
      logger.info(`  File uploaded successfully:`, { Key: result.Key, Location: result.Location });

      const bucketName =
        config.s3 && config.s3.bucket ? config.s3.bucket : process.env.S3_BUCKET || 'mock-bucket';
      const region =
        config.s3 && config.s3.region ? config.s3.region : process.env.AWS_REGION || 'mock-region';
      const contentType = f.mimetype || 'application/octet-stream';
      const size = f.size || 0;
      const s3Location =
        result.Location ||
        result.url ||
        `https://${bucketName}.s3.${region}.amazonaws.com/${result.Key || key}`;

      s3Staged.push({
        f,
        s3Key: result.Key || key,
        metadataFields: {
          key: result.Key || key,
          s3Location,
          bucketName,
          region,
          size,
          contentType,
          originalName: filename,
        },
      });
    }

    logger.info('🔄 Starting transaction to persist metadata and link documents to tenant...');
    try {
      const saved = await runInTransaction(async (session) => {
        const uploaded = [];
        for (const item of s3Staged) {
          const docs = await DocumentMetadata.create([item.metadataFields], { session });
          uploaded.push({ metadataId: docs[0]._id, s3Key: item.s3Key });
          logger.info(`  💾 Metadata created with ID: ${docs[0]._id}`);
        }
        const linked = await addDocumentsToTenantInSession(tenantId, uploaded, session);
        logger.info(`  Documents linked. Tenant now has ${linked.documents?.length || 0} documents`);
        return linked;
      });
      logger.info('Transaction committed successfully');

      for (const f of files) {
        try {
          require('fs').unlinkSync(f.path);
        } catch (ignore) {
          /* ignore */
        }
      }

      return saved;
    } catch (dbErr) {
      logger.error(' Transaction failed:', dbErr.message);
      for (const item of s3Staged) {
        try {
          if (item.s3Key) await s3Client.delete({ key: item.s3Key });
        } catch (ignore) {
          /* ignore */
        }
      }
      for (const f of files) {
        try {
          require('fs').unlinkSync(f.path);
        } catch (ignore) {
          /* ignore */
        }
      }
      throw dbErr;
    }
  } catch (e) {
    logger.error(' Upload failed:', e.message);
    // If upload to storage failed, attempt to cleanup any partial temp files and rethrow
    for (const f of files) {
      try {
        const safePath = path.resolve(f.path);
        if (safePath.startsWith(path.resolve(require('os').tmpdir()))) {
          require('fs').unlinkSync(safePath);
        }
      } catch (ignore) { /* ignore */ }
    }
    throw e;
  }
}

module.exports = Object.assign(module.exports, { uploadTenantDocuments });

/**
 * Export tenants as CSV for an owner. Accepts same filter as listTenants (requires createdBy).
 * Returns: { filename, csv }
 */
async function exportTenantsCsvService(filter = {}) {
  const createdBy = requireCreatedBy(filter);
  const tenantResult = await listTenants(filter);
  const tenants = Array.isArray(tenantResult?.data) ? tenantResult.data : [];

  // Header fields we want to export
  const headers = ['id', 'email', 'firstName', 'lastName', 'phone', 'address', 'state', 'zipCode', 'createdAt'];

  const rows = [headers.join(',')];
  for (const t of tenants || []) {
    const row = [
      csvEscape(t._id || ''),
      csvEscape(t.email || ''),
      csvEscape(t.firstName || ''),
      csvEscape(t.lastName || ''),
      csvEscape(t.phone || ''),
      csvEscape(t.address || ''),
      csvEscape(t.state || ''),
      csvEscape(t.zipCode || ''),
      csvEscape(t.createdAt ? DateUtil.toISO(t.createdAt) : ''),
    ];
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const filename = `tenants_export_${createdBy}_${Date.now()}.csv`;
  return { filename, csv };
}

module.exports = Object.assign(module.exports, { exportTenantsCsvService });
/**
 * Import tenants from a CSV file at local path `filePath`.
 * createdBy must be provided (resolved from request query) and will be applied to all imported tenants.
 * Expected CSV headers (case-insensitive):
 * email,phone,password,firstName,lastName,address,state,zipCode
 * Returns summary: { created: [{email,id}], failed: [{row,line,reason}] }
 */
async function importTenantsFromCsv(filePath, createdBy) {
  const fs = require('fs');
  const path = require('path');
  if (!filePath) { const err = new Error('filePath is required'); err.status = 400; throw err; }
  if (!fs.existsSync(filePath)) { const err = new Error('uploaded file not found'); err.status = 400; throw err; }

  const ownerId = requireCreatedBy({ createdBy });
  const owner = await User.findOne({ _id: ownerId, isDeleted: { $ne: true } });
  if (!owner) { const err = new Error('owner user not found'); err.status = 400; throw err; }

  const content = fs.readFileSync(filePath, 'utf8');
  // Normalize newlines and split lines
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) { const err = new Error('empty file'); err.status = 400; throw err; }

  // parse header
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const required = ['email', 'phone', 'password', 'firstname', 'lastname', 'address', 'state', 'zipcode'];
  for (const r of required) {
    if (!header.includes(r)) {
      const err = new Error(`missing required column: ${r}`); err.status = 400; throw err;
    }
  }

  const idx = {}; header.forEach((h, i) => idx[h] = i);

  const created = [];
  const failed = [];

  // Process rows sequentially to avoid DB contention
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // simple CSV split - assumes no embedded commas or quotes in input cells
    const cols = line.split(',').map(c => c.trim());
    const rowNum = i + 1;
    try {
      const email = cols[idx['email']] || '';
      const phone = cols[idx['phone']] || '';
      const password = cols[idx['password']] || '';
      const firstName = cols[idx['firstname']] || '';
      const lastName = cols[idx['lastname']] || '';
      const address = cols[idx['address']] || '';
      const state = cols[idx['state']] || '';
      const zipCode = cols[idx['zipcode']] || '';
      // Build tenant payload. createdBy is passed to the service and applied to all rows.
      if (!email || !phone || !password || !firstName || !lastName) {
        failed.push({ line: rowNum, reason: 'required fields missing', row: line });
        continue;
      }

      const payload = {
        email, phone, password, firstName, lastName, address, state, zipCode,
        createdBy: String(owner._id),
      };

      try {
        const createdUser = await createTenant(payload);
        created.push({ email: createdUser.email, id: String(createdUser._id) });
      } catch (e) {
        failed.push({ line: rowNum, reason: e && e.message ? e.message : 'create failed', row: line });
      }
    } catch (e) {
      failed.push({ line: i + 1, reason: e && e.message ? e.message : 'parse error', row: lines[i] });
    }
  }

  return { created, failed, totalRows: lines.length - 1 };
}

module.exports = Object.assign(module.exports, { importTenantsFromCsv });

/**
 * List tenants with advanced filtering, pagination, and property/lease data
 * Implementation is lease-based: fetch leases first, then get tenant and property details
 * @param {Object} filter - Filter parameters
 * @param {Object} pagination - Pagination parameters
 * @returns {Promise<{data: Array, total: number, page: number, pageSize: number}>}
 */
async function listTenantsWithDetails(filter = {}, pagination = {}) {
  const { getPagination } = require('../../../../../common/helpers/paginationHelper');
  const Property = require('../../property/model/property.model');
  const Lease = require('../../leasing/model/lease.model');
  const createdBy = resolveCreatedBy(filter);

  // Get pagination parameters
  const { offset, limit: effectiveLimit, page, pageSize: effectivePageSize } = getPagination({
    page: pagination.pageNumber,
    pageSize: pagination.pageSize
  });

  // Build lease query based on filters
  const leaseQuery = {};

  if (createdBy) {
    const propertyIds = await findPropertyIdsByCreatedBy(Property, createdBy);
    if (propertyIds.length === 0) {
      return {
        data: [],
        total: 0,
        page,
        pageSize: effectivePageSize,
      };
    }
    leaseQuery.property_id = { $in: propertyIds };
  }

  if (filter.propertyId) {
    leaseQuery.property_id = filter.propertyId;
  }
  if (filter.unitId) {
    leaseQuery.unitId = filter.unitId;
  } else if (filter.unit) {
    // Support both single unit (string) and multiple units (array)
    const units = Array.isArray(filter.unit) ? filter.unit : [filter.unit];
    leaseQuery.unitName = { $in: units };
  }

  // Get all leases with tenant splits
  const leases = await Lease.find({ ...leaseQuery, isDeleted: { $ne: true } })
    .select('_id property_id unitId unitName start_date end_date rentAndDepositDestribution status')
    .populate('property_id', 'name')
    .lean();

  if (leases.length === 0) {
    return {
      data: [],
      total: 0,
      page,
      pageSize: effectivePageSize
    };
  }

  // Extract all tenant IDs from lease splits
  const allTenantIds = new Set();
  const leaseTenantsMap = {};

  leases.forEach(lease => {
    if (lease.rentAndDepositDestribution?.split) {
      lease.rentAndDepositDestribution.split.forEach(split => {
        const tenantId = split.tenantId.toString();
        allTenantIds.add(tenantId);

        if (!leaseTenantsMap[tenantId]) {
          leaseTenantsMap[tenantId] = [];
        }

        leaseTenantsMap[tenantId].push({
          lease,
          property: lease.property_id,
          rentAmount: split.rentAmount,
          roommates: lease.rentAndDepositDestribution.split.length - 1,
          leaseId: lease._id
        });
      });
    }
  });

  // Build tenant query with filters
  const tenantQuery = {
    _id: { $in: Array.from(allTenantIds) },
    isDeleted: { $ne: true }
  };

  if (filter.tenantId) {
    tenantQuery._id = filter.tenantId;
  }
  if (createdBy) {
    Object.assign(tenantQuery, buildUserOwnerFilter(createdBy));
  }

  // Add search functionality - search by tenant name (firstName or lastName)
  if (filter.search && filter.search.trim().length > 0) {
    const searchRegex = { $regex: filter.search.trim(), $options: 'i' };
    tenantQuery.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { email: searchRegex }
    ];
  }

  if (filter.status) {
    tenantQuery.status = filter.status;
  }

  // Get ALL tenants without pagination first (to apply status filter), sorted by updatedAt desc
  const allTenants = await User.find(tenantQuery)
    .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -mfaOtp -mfaOtpExpiresAt -mfaOtpAction -refreshToken')
    .sort({ updatedAt: -1 })
    .lean();

  // Build full response data with status from User model
  const allResponseData = allTenants.map(tenant => {
    const tenantLeases = leaseTenantsMap[tenant._id.toString()] || [];
    const primaryLease = tenantLeases[0]; // Take first lease as primary

    return {
      tenantId: tenant._id,
      name: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'N/A',
      email: tenant.email || 'N/A',
      phone: tenant.phone || 'N/A',
      address: tenant.address || 'N/A',
      state: tenant.state || '',
      zipCode: tenant.zipCode || '',
      propertyName: primaryLease?.property?.name || 'N/A',
      unitName: primaryLease?.lease?.unitName || 'N/A',
      accountStatus: '', // Keep blank as requested
      status: tenant.status || 'Pending', // Include status from User model
      rent: primaryLease?.rentAmount || 0,
      roommates: primaryLease?.roommates || 0,
      leaseId: primaryLease?.leaseId || null,
      leaseStart: primaryLease?.lease?.start_date ? DateUtil.toISO(primaryLease.lease.start_date) : null,
      leaseEnd: primaryLease?.lease?.end_date ? DateUtil.toISO(primaryLease.lease.end_date) : null
    };
  });

  // Apply status filter if provided (using User model status field)
  const filteredData = filter.status
    ? allResponseData.filter(item => item.status === filter.status)
    : allResponseData;

  // Apply pagination AFTER filtering
  const paginatedData = filteredData.slice(offset, offset + effectiveLimit);
  const totalFiltered = filteredData.length;

  return {
    data: paginatedData,
    total: totalFiltered,
    page,
    pageSize: effectivePageSize
  };
}

module.exports = Object.assign(module.exports, { listTenantsWithDetails });

/**
 * Archive a tenant
 */
async function archiveTenantInSession(tenantId, session) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }

  const opts = { new: true };
  if (session) opts.session = session;

  const updated = await User.findOneAndUpdate(
    { _id: toObjectId(tenantId), isDeleted: { $ne: true } },
    { $set: { isArchived: true } },
    opts
  );

  if (!updated) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const obj = updated.toObject ? updated.toObject() : updated;
  delete obj.password;
  return obj;
}

async function archiveTenant(tenantId, options = {}) {
  return withTenantTransaction((session) => archiveTenantInSession(tenantId, session), options);
}

async function unarchiveTenantInSession(tenantId, session) {
  if (!tenantId) {
    const err = new Error('tenant id is required');
    err.status = 400;
    throw err;
  }

  const opts = { new: true };
  if (session) opts.session = session;

  const updated = await User.findOneAndUpdate(
    { _id: toObjectId(tenantId), isDeleted: { $ne: true } },
    { $set: { isArchived: false } },
    opts
  );

  if (!updated) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const obj = updated.toObject ? updated.toObject() : updated;
  delete obj.password;
  return obj;
}

async function unarchiveTenant(tenantId, options = {}) {
  return withTenantTransaction((session) => unarchiveTenantInSession(tenantId, session), options);
}

module.exports = Object.assign(module.exports, { archiveTenant, unarchiveTenant });

/**
 * Get tenant details with lease, invoice, and event information
 */
async function getTenantDetailsService(leaseId, tenantId, createdBy) {
  const ownerId = requireCreatedBy({ createdBy });

  logger.info('getTenantDetailsService called', { leaseId, tenantId, createdBy: ownerId });

  if (!tenantId) {
    logger.error('getTenantDetailsService: tenantId is required');
    const err = new Error('tenantId is required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    logger.error('getTenantDetailsService: Invalid tenantId format', { tenantId });
    const err = new Error('Invalid tenantId format');
    err.status = 400;
    throw err;
  }

  if (leaseId && !mongoose.Types.ObjectId.isValid(leaseId)) {
    logger.error('getTenantDetailsService: Invalid leaseId format', { leaseId });
    const err = new Error('Invalid leaseId format');
    err.status = 400;
    throw err;
  }

  // Initialize variables outside try block
  let lease = null;
  let collectionStats = {
    totalRentCollected: 0,
    otherCollected: 0,
    total: 0,
    currentInvoices: []
  };
  let tenant = null;
  let formattedLeaseHistory = [];
  let latestEvents = [];

  try {
    // Always fetch tenant details from User collection
    logger.info('Fetching tenant details from User collection', { tenantId });

    tenant = await User.findOne({
      _id: toObjectId(tenantId),
      isDeleted: { $ne: true },
      ...buildUserOwnerFilter(ownerId),
    })
      .populate('documents.metadataId')
      .select('-password -resetPasswordToken -resetPasswordExpiresAt -resetPasswordOtp -resetPasswordOtpExpiresAt -refreshToken')
      .lean();

    if (!tenant) {
      logger.error('getTenantDetailsService: Tenant not found or deleted', { tenantId });
      const err = new Error('Tenant not found or has been deleted');
      err.status = 404;
      throw err;
    }

    logger.info('Tenant details retrieved from User collection', { tenantId, tenantName: `${tenant.firstName} ${tenant.lastName}` });

    // Always fetch lease history and find active lease from Lease collection for the tenant
    logger.info('Fetching lease history from Lease collection', { tenantId });

    const Lease = require('../../leasing/model/lease.model');
    const Property = require('../../property/model/property.model');
    const propertyIds = await findPropertyIdsByCreatedBy(Property, ownerId);
    if (propertyIds.length === 0) {
      logger.warn('No owner-scoped properties found for tenant details request', { tenantId, createdBy: ownerId });
      const err = new Error('Tenant not found');
      err.status = 404;
      throw err;
    }
    const allLeases = await Lease.find({
      'rentAndDepositDestribution.split.tenantId': tenantId,
      property_id: { $in: propertyIds },
      isDeleted: { $ne: true },
    })
      .select('_id start_date end_date rentDetails status depositDetails')
      .sort({ start_date: -1 })
      .lean();

    logger.info('All leases retrieved from Lease collection', { tenantId, leaseCount: allLeases.length });

    // Determine which lease to use for detailed stats
    let selectedLease = null;

    if (leaseId) {
      // If leaseId is provided, find that specific lease
      selectedLease = allLeases.find(l => l._id.toString() === leaseId);

      if (!selectedLease) {
        logger.error('getTenantDetailsService: Lease not found', { leaseId });
        const err = new Error('Lease not found');
        err.status = 404;
        throw err;
      }

      // Verify tenant exists in this lease
      const leaseDoc = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } }).lean();
      const tenantExistsInLease = leaseDoc.rentAndDepositDestribution?.split?.some(
        split => split.tenantId?.toString() === tenantId
      );

      if (!tenantExistsInLease) {
        logger.error('getTenantDetailsService: Tenant not found in lease', { leaseId, tenantId });
        const err = new Error('Tenant not found in this lease');
        err.status = 404;
        throw err;
      }
    } else {
      // If leaseId is NOT provided, find the current/active lease
      const now = ClockService.now();

      // First, try to find an ACTIVE lease
      selectedLease = allLeases.find(l => l.status === 'active' || l.status === 'Active');

      // If no active lease, find one where end_date is in the future
      if (!selectedLease) {
        selectedLease = allLeases.find(l => l.end_date && !DateUtil.isPast(l.end_date, now));
      }

      // If still no lease, use the most recent one
      if (!selectedLease && allLeases.length > 0) {
        selectedLease = allLeases[0];
      }

      if (selectedLease) {
        logger.info('Auto-detected active/current lease for tenant', { tenantId, selectedLeaseId: selectedLease._id });
      } else {
        logger.warn('No lease found for tenant', { tenantId });
      }
    }

    // Fetch lease details and collection stats only if lease was selected
    if (selectedLease) {
      logger.info('Using lease for detailed stats', { leaseId: selectedLease._id });

      lease = {
        _id: selectedLease._id,
        start_date: selectedLease.start_date,
        end_date: selectedLease.end_date,
        status: selectedLease.status,
        rentDetails: selectedLease.rentDetails,
        depositDetails: selectedLease.depositDetails
      };

      // Fetch collection stats from Invoice collection
      const Invoice = require('../../invoice/model/invoice.model');
      const { INVOICE_TYPES, INVOICE_STATUS } = require('../../../../../common/constants/invoice');

      let invoices = [];

      logger.info('Fetching invoices for tenant and owner properties', { tenantId, createdBy: ownerId, propertyCount: propertyIds.length });

      // Fetch invoices where tenantId is in tenants array AND propertyId matches landlord's properties
      invoices = await Invoice.find({
        tenants: tenantId,
        propertyId: { $in: propertyIds },
        isDeleted: { $ne: true },
      })
        .select('invoiceId status type subAmount balanceDue dueDate alreadyPaid createdAt lease_id paidOn')
        .sort({ createdAt: -1 })
        .lean();

      logger.info('Invoices retrieved for collection stats', { leaseId: selectedLease._id, createdBy: ownerId, tenantId, invoiceCount: invoices.length });

      // Filter for current month and past due invoices
      const now = ClockService.now();
      const todayParts = parseAppYmd(DateUtil.toEST(now));

      // Get ALL invoices DUE in current month (regardless of payment status)
      const currentMonthInvoices = invoices.filter(inv => {
        if (!inv.dueDate) return false;
        const dueParts = parseAppYmd(DateUtil.toEST(inv.dueDate));
        if (!dueParts || !todayParts) return false;
        return dueParts.y === todayParts.y && dueParts.m === todayParts.m;
      });

      // Get past due invoices - ANY invoice that:
      // 1. Has status OVERDUE, OR
      // 2. Is not PAID and due date is in the past
      const pastDueInvoices = invoices.filter(inv => {
        if (!inv.dueDate) return false;

        const isOverdueStatus = inv.status === INVOICE_STATUS.OVERDUE;
        const isPastDueUnpaid = inv.status !== INVOICE_STATUS.PAID && DateUtil.isPast(inv.dueDate, now);

        return isOverdueStatus || isPastDueUnpaid;
      });

      // Combine current month invoices and past due invoices, avoiding duplicates
      const relevantInvoices = [...currentMonthInvoices];

      // Add past due invoices that aren't already in the array
      pastDueInvoices.forEach(inv => {
        if (!relevantInvoices.some(existing => existing._id.toString() === inv._id.toString())) {
          relevantInvoices.push(inv);
        }
      });

      logger.info('Filtered invoices for current month and past due', {
        leaseId: selectedLease._id,
        currentMonthCount: currentMonthInvoices.length,
        pastDueCount: pastDueInvoices.length,
        totalRelevantInvoices: relevantInvoices.length,
        pastDueDetails: pastDueInvoices.map(inv => ({
          invoiceId: inv._id,
          status: inv.status,
          dueDate: inv.dueDate
        }))
      });

      const paidInvoices = invoices.filter(inv => inv?.status === INVOICE_STATUS.PAID);

      const totalRentCollected = paidInvoices
        .filter(inv => inv?.type === INVOICE_TYPES.RENT)
        .reduce((sum, inv) => sum + (inv?.subAmount || 0), 0);

      const otherCollected = paidInvoices
        .filter(inv => inv?.type && inv.type !== INVOICE_TYPES.RENT)
        .reduce((sum, inv) => sum + (inv?.subAmount || 0), 0);

      const totalCollected = totalRentCollected + otherCollected;

      logger.info('Collection statistics calculated from Invoice collection', {
        leaseId: selectedLease._id,
        totalRentCollected,
        otherCollected,
        totalCollected
      });

      collectionStats = {
        totalRentCollected: Number(totalRentCollected.toFixed(2)),
        otherCollected: Number(otherCollected.toFixed(2)),
        total: Number(totalCollected.toFixed(2)),
        currentInvoices: currentMonthInvoices,
        pastDueInvoices: pastDueInvoices,
        allRelevantInvoices: relevantInvoices
      };
    }

    const now = ClockService.now();

    // Format lease history excluding the currently selected lease
    const leaseHistoryData = selectedLease
      ? allLeases.filter(l => l._id.toString() !== selectedLease._id.toString())
      : allLeases;

    formattedLeaseHistory = (leaseHistoryData || []).map(historyLease => {
      const daysRemaining = historyLease.end_date && !DateUtil.isPast(historyLease.end_date, now)
        ? DateUtil.diffDays(now, historyLease.end_date)
        : 0;

      return {
        leaseId: historyLease._id,
        monthlyRent: historyLease.rentDetails?.amount || 0,
        startDate: historyLease.start_date,
        endDate: historyLease.end_date,
        daysRemaining,
        status: historyLease.status
      };
    });

    // Fetch messages from Events collection based on tenant's properties
    logger.info('Fetching messages from Events collection for tenant', { tenantId });

    const Event = require('../../../../../shared/modules/events/model/event.model');

    if (lease && lease.property_id) {
      // If lease provided, get events for that property
      latestEvents = await Event.find({
        propertyId: lease.property_id
      })
        .populate('from', 'firstName lastName email')
        .populate('to', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      logger.info('Messages retrieved from Events collection for property', { propertyId: lease.property_id, eventCount: latestEvents.length });
    } else {
      // If no lease, get events where tenant is involved
      latestEvents = await Event.find({
        $or: [
          { from: tenantId },
          { to: tenantId }
        ]
      })
        .populate('from', 'firstName lastName email')
        .populate('to', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      logger.info('Messages retrieved from Events collection for tenant', { tenantId, eventCount: latestEvents.length });
    }

  } catch (error) {
    logger.error('Error fetching tenant details', {
      leaseId,
      tenantId,
      error: error.message,
      stack: error.stack
    });

    // Re-throw validation and business logic errors
    if (error.status && error.status < 500) {
      throw error;
    }

    // For unexpected errors, throw a generic 500 error
    const err = new Error('Internal server error while fetching tenant details');
    err.status = 500;
    throw err;
  }

  logger.info('Tenant details service completed successfully', { leaseId: leaseId || 'none', tenantId, createdBy: ownerId });

  // Return the currently selected lease as the active lease, or find from history
  let activeLease = null;
  if (lease) {
    // Use the lease object we prepared earlier
    activeLease = {
      leaseId: lease._id,
      monthlyRent: lease.rentDetails?.amount || 0,
      startDate: lease.start_date,
      endDate: lease.end_date,
      status: lease.status
    };
  } else {
    // If no lease was selected, find active from history
    activeLease = formattedLeaseHistory.find(l => l.status === 'Active' || l.status === 'active') ||
      (formattedLeaseHistory.length > 0 ? formattedLeaseHistory[0] : null);
  }

  // Return segregated response structure with data from correct collections
  return {
    lease,
    collectionStats,
    tenantDetails: tenant,
    leaseHistory: formattedLeaseHistory,
    messageHistory: latestEvents || [],
    activeLease
  };
}

/**
 * Update tenant setup - completely separate API from setupTenant
 * Accepts payload: { tenants: [...], lease: { leaseId, ... } }
 * For UPDATE flow: finds existing tenant users by email, updates them, and updates the lease
 * If tenant user doesn't exist, creates new one
 * Returns { tenants, lease }
 */
async function updateSetupTenantInSession(payload, session, options = {}) {
  const body = payload || {};
  const tenantsData = Array.isArray(body.tenants) ? body.tenants : [];
  const leaseData = body.lease;

  if (!Array.isArray(tenantsData) || tenantsData.length === 0) {
    const err = new Error('tenants array is required and must contain at least one tenant');
    err.status = 400;
    throw err;
  }
  if (!leaseData || !leaseData.leaseId) {
    const err = new Error('lease payload with leaseId is required in request body as `lease.leaseId`');
    err.status = 400;
    throw err;
  }

  const Lease = require('../../leasing/model/lease.model');
  const existingLease = await applySession(
    Lease.findOne({ _id: leaseData.leaseId, isDeleted: { $ne: true } }),
    session
  );
  if (!existingLease) {
    const err = new Error('lease not found');
    err.status = 404;
    throw err;
  }

  const existingLeaseStatus = String(existingLease.status || '').toLowerCase();
  const isExistingLeaseEligibleForDeferredInvoiceRefresh =
    existingLeaseStatus === String(LEASE_STATUSES.ACTIVE).toLowerCase() ||
    existingLeaseStatus === String(LEASE_STATUSES.APPROVED).toLowerCase();
  const existingTenantIds = new Set(
    (Array.isArray(existingLease?.rentAndDepositDestribution?.split)
      ? existingLease.rentAndDepositDestribution.split
      : []
    )
      .map((s) => String(s?.tenantId || ''))
      .filter(Boolean)
  );
  let newlyAddedTenantChannels = [];

  // Validate property early to ensure consistency
  if (leaseData.property_id) {
    if (!mongoose.Types.ObjectId.isValid(String(leaseData.property_id))) {
      const err = new Error('lease.property_id must be a valid ObjectId');
      err.status = 400;
      throw err;
    }
    const Property = require('../../property/model/property.model');
    const propertyExists = await applySession(
      Property.findOne({ _id: leaseData.property_id, isDeleted: { $ne: true } }),
      session
    ).lean();
    if (!propertyExists) {
      const err = new Error('property not found');
      err.status = 400;
      throw err;
    }
    const createdByFromProperty = getCreatorIdFromProperty(propertyExists);
    if (!createdByFromProperty) {
      const err = new Error('property is not associated with an owner');
      err.status = 400;
      throw err;
    }
  }

  // Update or create tenants
  const updatedTenants = [];
  const updatedTenantKeyMap = {}; // key => id for split mapping

  for (const tData of tenantsData) {
    if (!tData || !tData.key) {
      const err = new Error('each tenant must include an explicit `key` field');
      err.status = 400;
      throw err;
    }

    const providedKey = String(tData.key);
    // ensure no duplicate keys in the same payload
    if (updatedTenantKeyMap[providedKey]) {
      const err = new Error(`duplicate tenant key in payload: ${providedKey}`);
      err.status = 400;
      throw err;
    }

    // Enforce request-level validation: each tenant object must include email and phone
    // (even if an existing user is being referenced). This ensures FE submits complete data.
    if (!tData.email) {
      const err = new Error("Without an email address, you will be unable to send documents to be signed, request renter's insurance, or collect payments online. Are you sure you'd like to proceed?");
      err.status = 400;
      throw err;
    }
    // validate email format
    const { isValidEmail } = require('../../../../../common/helpers/validationHelper');
    if (!isValidEmail(tData.email)) {
      const err = new Error('tenant email must be a valid email address');
      err.status = 400;
      throw err;
    }

    // Phone is optional for tenants in the setup payload. If provided, validate format.
    if (tData.phone) {
      // Accept international phone numbers with 7-15 digits
      if (!isValidInternationalPhone(tData.phone)) {
        const err = new Error('tenant phone must be a valid phone number (7-15 digits, country code allowed)');
        err.status = 400;
        throw err;
      }
    }

    if (!resolveCreatedBy(tData) && leaseData.property_id) {
      if (!mongoose.Types.ObjectId.isValid(String(leaseData.property_id))) {
        const err = new Error('lease.property_id must be a valid ObjectId');
        err.status = 400;
        throw err;
      }
      const Property = require('../../property/model/property.model');
      const propertyExists = await applySession(
        Property.findOne({ _id: leaseData.property_id, isDeleted: { $ne: true } }),
        session
      ).lean();
      if (!propertyExists) {
        const err = new Error('property not found');
        err.status = 400;
        throw err;
      }
      const createdByFromProperty = getCreatorIdFromProperty(propertyExists);
      if (!createdByFromProperty) {
        const err = new Error('property is not associated with an owner');
        err.status = 400;
        throw err;
      }
      if (!resolveCreatedBy(tData)) tData.createdBy = createdByFromProperty;
    }

    let tenantUser;
    const existingUser = await applySession(
      User.findOne({ email: tData.email, isDeleted: { $ne: true } }),
      session
    );

    if (existingUser) {
      tenantUser = await reuseExistingTenantFromPayload(existingUser, tData, session);
    } else {
      // Create new tenant using createTenantInSession which handles company role assignment
      tenantUser = await createTenantInSession(tData, session);
    }

    updatedTenants.push({ user: tenantUser, key: providedKey });
    updatedTenantKeyMap[providedKey] = String(tenantUser._id || (tenantUser.toObject ? tenantUser.toObject()._id : ''));
  }

  // Prepare rentAndDepositDestribution.split: update split entries with new tenant IDs
  if (!leaseData.rentAndDepositDestribution) leaseData.rentAndDepositDestribution = {};
  const rd = leaseData.rentAndDepositDestribution;

  if (!Array.isArray(rd.split) || rd.split.length === 0) {
    const err = new Error('rentAndDepositDestribution.split is required and must contain one entry per tenant');
    err.status = 400;
    throw err;
  }

  // Map keys to updated tenant IDs
  for (const s of rd.split) {
    if (s.key) {
      const k = String(s.key);
      if (updatedTenantKeyMap[k]) {
        s.tenantId = updatedTenantKeyMap[k];
      }
    }
  }

  remapLeaseTenantClientKeys(leaseData, updatedTenantKeyMap);

  // Coerce numeric fields to Number and normalize tenantId to string
  rd.split = rd.split.map((s) => {
    const out = Object.assign({}, s);
    if (out.rentAmount !== undefined) out.rentAmount = Number(out.rentAmount);
    if (out.rentPercentage !== undefined) out.rentPercentage = Number(out.rentPercentage);
    if (out.depositAmount !== undefined) out.depositAmount = Number(out.depositAmount);
    if (out.depositPercentage !== undefined) out.depositPercentage = Number(out.depositPercentage);
    if (out.tenantId) out.tenantId = String(out.tenantId);
    return out;
  });

  if (isExistingLeaseEligibleForDeferredInvoiceRefresh) {
    newlyAddedTenantChannels = rd.split
      .filter((s) => {
        const tenantId = String(s?.tenantId || '');
        return tenantId && !existingTenantIds.has(tenantId);
      })
      .map((s) => {
        const screening = Array.isArray(s?.screening) ? s.screening : [];
        const channel = screening.length > 0 ? 'application' : 'invite';
        return { tenantId: String(s.tenantId), channel };
      });
  }

  // Update the lease
  const leasingService = require('../../leasing/service/lease.service');
  const updatedLease = await leasingService.updateLeaseService(leaseData.leaseId, leaseData, {
    session,
    actorId: options?.actorId || body.updatedBy || null,
  });

  const tenantsSafe = updatedTenants.map(({ user }) => {
    const obj = user && user.toObject ? user.toObject() : user || {};
    if (obj && obj.password) delete obj.password;
    return obj;
  });

  return {
    tenantsSafe,
    updatedLease,
    postCommit: {
      leaseId: String(leaseData.leaseId),
      isExistingLeaseEligibleForDeferredInvoiceRefresh,
      newlyAddedTenantChannels,
    },
  };
}

async function updateSetupTenant(payload = {}, options = {}) {
  const dbResult = options.session
    ? await updateSetupTenantInSession(payload, options.session, options)
    : await runInTransaction((session) => updateSetupTenantInSession(payload, session, options));

  const { postCommit } = dbResult;
  if (
    postCommit &&
    postCommit.isExistingLeaseEligibleForDeferredInvoiceRefresh &&
    postCommit.newlyAddedTenantChannels &&
    postCommit.newlyAddedTenantChannels.length > 0
  ) {
    (async () => {
      for (const row of postCommit.newlyAddedTenantChannels) {
        try {
          await resendLeaseTenantCommunicationService(
            postCommit.leaseId,
            row.tenantId,
            row.channel
          );
        } catch (e) {
          logger.warn(
            `Failed to send ${row.channel} communication for tenant ${row.tenantId} on lease ${postCommit.leaseId}:`,
            e && e.message
          );
        }
      }
    })();
  }

  return { tenants: dbResult.tenantsSafe, lease: dbResult.updatedLease };
}

/**
 * Send screening application invitations to tenants
 * Creates a Submitted lease (same as setup) and sends invitation emails for tenant screening
 * @param {Object} payload - { tenants, lease }
 * @returns {Promise<Object>} { lease, tenants }
 */
async function sendApplicationInvitation(payload = {}, options = {}) {
  const { tenants = [], lease = {} } = payload;

  if (!tenants || tenants.length === 0) {
    const err = new Error('At least one tenant is required');
    err.status = 400;
    throw err;
  }

  if (!lease || !lease.property_id) {
    const err = new Error('Property ID is required');
    err.status = 400;
    throw err;
  }

  logger.info('sendApplicationInvitation: Starting setup');

  // Call setupTenant to create the lease and users, but skip the email
  // since we'll send emails asynchronously in the background
  const setupResult = await setupTenant(payload, { skipInviteEmail: true, inviterUserId: options.inviterUserId });
  const createdLease = setupResult.lease;
  const createdTenants = setupResult.tenants;

  logger.info('sendApplicationInvitation: Setup completed, lease ID:', createdLease._id);

  // Send emails asynchronously in the background (non-blocking)
  setImmediate(async () => {
    try {
      const Lease = require('../../leasing/model/lease.model');
      const { sendLeaseTenantOnboardingEmails } = require('../../leasing/service/leaseTenantInviteDelivery.service');

      const freshLease = await Lease.findOne({ _id: toObjectId(createdLease._id), isDeleted: { $ne: true } }).lean();
      const payloadSplit = lease?.rentAndDepositDestribution?.split || [];
      const leaseSplit =
        freshLease?.rentAndDepositDestribution?.split ||
        createdLease.rentAndDepositDestribution?.split ||
        payloadSplit;

      logger.info('sendApplicationInvitation: Sending onboarding emails in background');

      const {
        results: emailResults,
        inviteRecipients = [],
        screeningRecipients = [],
      } = await sendLeaseTenantOnboardingEmails({
        leaseId: String(createdLease._id),
        createdTenants,
        tenantsData: tenants,
        leaseSplit,
        inviterUserId: options.inviterUserId,
      });

      const failed = emailResults.filter((r) => !r.sent);
      const inviteList = inviteRecipients.length ? inviteRecipients.join(', ') : 'none';
      const screeningList = screeningRecipients.length ? screeningRecipients.join(', ') : 'none';

      if (failed.length > 0) {
        logger.warn(
          `sendApplicationInvitation: ${failed.length} email(s) failed for lease ${createdLease._id}:`,
          failed.map((f) => f.email || f.tenantId).join(', ')
        );
      } else {
        logger.info(
          `sendApplicationInvitation: All emails sent successfully for lease ${createdLease._id}. ` +
          `Invite sent to: ${inviteList}. Screening sent to: ${screeningList}.`
        );
      }
    } catch (err) {
      logger.error(
        `sendApplicationInvitation: Background email sending failed for lease ${createdLease._id}:`,
        err.message,
        err.stack
      );
    }
  });

  // Return response immediately without waiting for emails
  logger.info('sendApplicationInvitation: Returning immediate response');

  const responseData = {
    lease: createdLease,
    tenants: createdTenants,
    message: 'Lease created successfully. Invitation emails are being sent in the background.',
    status: 'processing',
  };

  return responseData;
}

module.exports = Object.assign(module.exports, { getTenantDetailsService, updateTenantSetup, updateSetupTenant, sendApplicationInvitation });

/**
 * Build onboarding status for all tenants on a Submitted (in-progress) lease.
 */
async function getLeaseOnboardingStatusService(leaseId) {
  if (!leaseId) {
    const err = new Error('leaseId is required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(leaseId))) {
    const err = new Error('invalid leaseId');
    err.status = 400;
    throw err;
  }

  const Lease = require('../../leasing/model/lease.model');
  const Application = require('../../application/models/application.model');
  const { findAcksForLease } = require('../../leasing/service/leaseTenantInviteAck.service');

  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } }).lean();
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  const split = Array.isArray(lease.rentAndDepositDestribution?.split)
    ? lease.rentAndDepositDestribution.split
    : [];
  const tenantIds = split
    .map((s) => String(s?.tenantId || ''))
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const tenantUsers = tenantIds.length
    ? await User.find({ _id: { $in: tenantIds }, isDeleted: { $ne: true } }).select('firstName lastName email screening').lean()
    : [];
  const userMap = tenantUsers.reduce((acc, u) => {
    acc[String(u._id)] = u;
    return acc;
  }, {});

  const applications = tenantIds.length
    ? await Application.find({
      lease_id: lease._id,
      tenant_id: { $in: tenantIds },
      isDeleted: { $ne: true },
    })
      .select('tenant_id status')
      .sort({ createdAt: -1 })
      .lean()
    : [];

  const inviteAckRows = await findAcksForLease(lease._id);
  const inviteAckByTenant = inviteAckRows.reduce((acc, row) => {
    const key = String(row.tenant_id || row.tenantId || '');
    if (key) acc[key] = row;
    return acc;
  }, {});

  const { hasTenantScreening } = require('../../leasing/service/leaseTenantInviteDelivery.service');

  const latestByTenant = {};
  applications.forEach((app) => {
    const tid = String(app.tenant_id || '');
    if (!latestByTenant[tid]) latestByTenant[tid] = app;
  });

  const tenants = split.map((s, idx) => {
    const tenantId = String(s?.tenantId || '');
    const user = userMap[tenantId];
    const screening = Array.isArray(s?.screening) ? s.screening : (Array.isArray(user?.screening) ? user.screening : []);
    const needsScreening = hasTenantScreening(screening);
    const needsApplication = screening.includes('application');
    const app = latestByTenant[tenantId];
    const appStatus = app?.status ? String(app.status).toLowerCase() : null;
    const isSubmitted = !!appStatus && !['rejected'].includes(appStatus);
    const isApproved = appStatus === 'approved';
    const ackRow = inviteAckByTenant[tenantId];
    const splitAck = !!s.inviteAcknowledged;
    const isInviteAcknowledged = !!(ackRow && ackRow.isAcknowledged) || splitAck;
    const isInviteSent = !!(ackRow && ackRow.inviteSentAt);

    return {
      tenantId,
      displayName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || `Tenant ${idx + 1}`,
      email: user?.email || '',
      screening,
      needsScreening,
      needsApplication,
      applicationStatus: appStatus,
      isApplicationSubmitted: isSubmitted,
      isApplicationApproved: isApproved,
      isInviteAcknowledged,
      isInviteSent,
      hasInviteTracking: true,
      canResendApplication: needsScreening && !isApproved,
      canResendInvite: isInviteSent && !isInviteAcknowledged && (!needsApplication || isApproved),
    };
  });

  return {
    leaseId: String(lease._id),
    leaseStatus: String(lease.status || '').toLowerCase(),
    tenants,
  };
}

/**
 * Resend either screening application email or non-screening invite email.
 */
async function resendLeaseTenantCommunicationService(leaseId, tenantId, channel) {
  if (!leaseId || !tenantId) {
    const err = new Error('leaseId and tenantId are required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(leaseId)) || !mongoose.Types.ObjectId.isValid(String(tenantId))) {
    const err = new Error('leaseId and tenantId must be valid ObjectIds');
    err.status = 400;
    throw err;
  }
  if (!['application', 'invite'].includes(String(channel))) {
    const err = new Error('channel must be either application or invite');
    err.status = 400;
    throw err;
  }

  const Lease = require('../../leasing/model/lease.model');
  const safeLeaseId = toObjectId(leaseId);
  const safeTenantId = toObjectId(tenantId);

  const [lease, tenant] = await Promise.all([
    Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } }).lean(),
    User.findOne({ _id: safeTenantId, isDeleted: { $ne: true } }).lean(),
  ]);

  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }
  if (!tenant) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  const split = Array.isArray(lease.rentAndDepositDestribution?.split) ? lease.rentAndDepositDestribution.split : [];
  const onLease = split.some((s) => String(s?.tenantId || '') === String(tenantId));
  if (!onLease) {
    const err = new Error('Tenant is not on this lease');
    err.status = 403;
    throw err;
  }

  let propertyOwnerId = null;
  if (lease.property_id) {
    const Property = require('../../property/model/property.model');
    const property = await Property.findOne({ _id: toObjectId(lease.property_id), isDeleted: { $ne: true } })
      .select('createdBy landlord_id')
      .lean();
    propertyOwnerId = getCreatorIdFromProperty(property);
  }

  if (channel === 'application') {
    const { sendTenantScreeningApplicationEmail } = require('../../leasing/service/leaseTenantInviteDelivery.service');
    const safeTenantIdStr = String(safeTenantId);
    const screening = split.find((s) => String(s?.tenantId || '') === safeTenantIdStr)?.screening || [];
    await sendTenantScreeningApplicationEmail({
      leaseId: String(leaseId),
      tenantId: String(tenantId),
      screening,
    });
  } else {
    const { sendLeaseTenantInviteEmail } = require('../../leasing/service/leaseTenantInviteDelivery.service');
    await sendLeaseTenantInviteEmail({
      leaseId: String(leaseId),
      tenantId: String(tenantId),
      inviterUserId: propertyOwnerId,
    });
  }

  return { leaseId, tenantId, channel, sent: true };
}

async function acknowledgeLeaseInviteForTenant(leaseId, tenantId) {
  const { acknowledgeLeaseInvite } = require('../../leasing/service/leaseAutoApproval.service');
  return acknowledgeLeaseInvite(leaseId, tenantId);
}

/**
 * Screening form context for a tenant on a lease (read-only).
 */
async function getScreeningContextService(leaseId, tenantId) {
  if (!leaseId || !tenantId) {
    const err = new Error('leaseId and tenantId are required');
    err.status = 400;
    throw err;
  }

  const Lease = require('../../leasing/model/lease.model');
  const lease = await Lease.findOne({ _id: leaseId, isDeleted: { $ne: true } }).lean();
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  const split = lease.rentAndDepositDestribution?.split || [];
  const onLease = split.some((s) => {
    const id = s.tenantId;
    const sid = id && typeof id === 'object' && id._id ? String(id._id) : String(id || '');
    return sid === String(tenantId);
  });
  if (!onLease) {
    const err = new Error('Tenant is not on this lease');
    err.status = 403;
    throw err;
  }

  const tenant = await User.findOne({ _id: tenantId, isDeleted: { $ne: true } })
    .select('firstName lastName email phone')
    .lean();
  if (!tenant) {
    const err = new Error('Tenant not found');
    err.status = 404;
    throw err;
  }

  return {
    propertyId: lease.property_id ? String(lease.property_id) : '',
    firstName: tenant.firstName || '',
    lastName: tenant.lastName || '',
    email: tenant.email || '',
    phone: tenant.phone || '',
  };
}

/** Strip secrets from a tenant user document for API responses. */
function sanitizeTenantUserForResponse(user) {
  if (!user) return null;
  if (typeof user.toSafeJSON === 'function') return user.toSafeJSON();
  const obj = user.toObject ? user.toObject() : { ...user };
  if (obj.password) delete obj.password;
  if (Object.prototype.hasOwnProperty.call(obj, '_portalInviteUsed')) delete obj._portalInviteUsed;
  return obj;
}

/** Merge landlord/PM actor into list/export filter payloads. */
function mergeTenantScopeFromActor(payload = {}, actorId) {
  return Object.assign({}, payload, {
    createdBy: resolveCreatedBy(payload, actorId),
  });
}

/**
 * get Actor Id From Options
 *
 * Performs logic operations for getActorIdFromOptions.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function getActorIdFromOptions(options = {}) {
  return options.actorId || options.inviterUserId || null;
}

module.exports = Object.assign(module.exports, {
  getLeaseOnboardingStatusService,
  resendLeaseTenantCommunicationService,
  acknowledgeLeaseInviteForTenant,
  getScreeningContextService,
  sanitizeTenantUserForResponse,
  mergeTenantScopeFromActor,
  getActorIdFromOptions,
  withTenantTransaction,
  runInTransaction,
});
