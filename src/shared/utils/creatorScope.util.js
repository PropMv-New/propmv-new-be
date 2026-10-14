/**
 * ------------------------------------------------------------------
 * File: creatorScope.util.js
 * Module: Src Shared Utils
 *
 * Purpose:
 * Backend utility/module providing helper functions for creatorScope.util.
 *
 * Used By:
 * landlordRouteConfig, landlordDataIsolation, roleBasedDataIsolation, application.controller
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const User = require('../modules/users/models/user.model');
const logger = require('../../common/logger');
const { PROPERTY_SOURCE_PORTAL } = require('../../common/constants/property');

const MATCH_NO_DOCUMENTS = Object.freeze({ _id: { $in: [] } });

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * to Creator Candidates
 *
 * Performs logic operations for toCreatorCandidates.
 *
 * @param createdBy - Request/input argument
 * @returns Operations result
 */
function toCreatorCandidates(createdBy) {
  const raw = String(createdBy || '').trim();
  if (!raw) {
    return [];
  }

  const candidates = [raw];
  if (mongoose.Types.ObjectId.isValid(raw)) {
    candidates.push(new mongoose.Types.ObjectId(raw));
  }

  return candidates;
}

function isAdministratorScope(value) {
  return typeof value === 'object' && value !== null && value.isAdministrator === true;
}

/**
 * resolve Created By
 *
 * Performs logic operations for resolveCreatedBy.
 *
 * @param source - Request/input argument
 * @param fallback - Request/input argument
 * @returns Operations result
 */
function resolveCreatedBy(source, fallback = null) {
  if (source == null) {
    return fallback;
  }

  if (typeof source === 'string') {
    const value = source.trim();
    return value || fallback;
  }

  // Administrator company-wide scope (passed directly or nested under createdBy)
  if (isAdministratorScope(source)) {
    return source;
  }

  const value = source.createdBy || source.landlordId || source.landlord_id || fallback;
  if (value == null) {
    return null;
  }

  if (isAdministratorScope(value)) {
    return value;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

/**
 * strip Legacy Owner Fields
 *
 * Performs logic operations for stripLegacyOwnerFields.
 *
 * @param target - Request/input argument
 * @returns Operations result
 */
function stripLegacyOwnerFields(target) {
  if (!target || typeof target !== 'object') {
    return target;
  }

  delete target.landlordId;
  delete target.landlord_id;
  return target;
}

/**
 * require Created By
 *
 * Performs logic operations for requireCreatedBy.
 *
 * @param source - Request/input argument
 * @param fieldName - Request/input argument
 * @returns Operations result
 */
function requireCreatedBy(source, fieldName = 'createdBy') {
  const createdBy = resolveCreatedBy(source);
  if (!createdBy) {
    const err = new Error(`${fieldName} is required`);
    err.status = 400;
    throw err;
  }

  // If createdBy is an admin-scope object, validate expected shape and return it
  if (typeof createdBy === 'object' && createdBy !== null) {
    const maybeUserId = createdBy.userId || createdBy._id || createdBy.id;
    if (!maybeUserId || !mongoose.Types.ObjectId.isValid(String(maybeUserId))) {
      const err = new Error(`${fieldName}.userId must be a valid ObjectId when using administrator scope`);
      err.status = 400;
      throw err;
    }
    // Return the object so callers can detect admin scope
    return createdBy;
  }

  if (!mongoose.Types.ObjectId.isValid(String(createdBy))) {
    const err = new Error(`${fieldName} must be a valid ObjectId`);
    err.status = 400;
    throw err;
  }
  return String(createdBy).trim();
}

/**
 * Get all company user IDs for Administrator users
 * For non-Administrator users, returns only the user's own ID
 * @param {string} userId - The user ID
 * @param {boolean} isAdministrator - Whether user is Administrator
 * @param {ObjectId} companyId - The company ID
 * @returns {Array<ObjectId>} Array of user IDs to query
 */
async function resolveCreatorScope(userId, isAdministrator = false, companyId = null) {
  // If not Administrator, return only the user's own ID
  if (!isAdministrator || !companyId) {
    const candidates = toCreatorCandidates(userId);
    return candidates;
  }

  try {
    // Get all users in the company
    const safeCompanyId = toObjectId(companyId);
    if (!safeCompanyId) return toCreatorCandidates(userId);
    const companyUsers = await User.find({
      companyId: safeCompanyId,
      isDeleted: { $ne: true },
    })
      .select('_id')
      .lean();

    const userIds = companyUsers.map((u) => u._id);
    
    // Include both ObjectId and string versions
    const candidates = [];
    userIds.forEach((id) => {
      candidates.push(id);
      candidates.push(String(id));
    });
    
    return candidates.length > 0 ? candidates : toCreatorCandidates(userId);
  } catch (error) {
    logger.error('Error resolving creator scope:', error.message);
    // Fallback to user's own ID on error
    return toCreatorCandidates(userId);
  }
}

/**
 * build Property Owner Filter
 *
 * Performs logic operations for buildPropertyOwnerFilter.
 *
 * @param createdBy - Request/input argument
 * @returns Operations result
 */
function buildPropertyOwnerFilter(createdBy) {
  const candidates = sanitizeCandidates(toCreatorCandidates(createdBy));
  if (candidates.length === 0) {
    return {};
  }

  return {
    $or: [
      { createdBy: { $in: candidates } },
      { landlord_id: { $in: candidates } },
      { landlordId: { $in: candidates } },
    ],
  };
}

/**
 * Build property owner filter with Administrator support
 * @param {Array} creatorCandidates - Array of user IDs from resolveCreatorScope
 * @returns {Object} MongoDB filter object
 */
function buildPropertyOwnerFilterWithScope(creatorCandidates) {
  if (!Array.isArray(creatorCandidates) || creatorCandidates.length === 0) {
    return {};
  }

  return {
    $or: [
      { createdBy: { $in: creatorCandidates } },
      { landlord_id: { $in: creatorCandidates } },
      { landlordId: { $in: creatorCandidates } },
    ],
  };
}

/**
 * build User Owner Filter
 *
 * Performs logic operations for buildUserOwnerFilter.
 *
 * @param createdBy - Request/input argument
 * @returns Operations result
 */
function buildUserOwnerFilter(createdBy) {
  const candidates = sanitizeCandidates(toCreatorCandidates(createdBy));
  if (candidates.length === 0) {
    return {};
  }

  return {
    $or: [
      { createdBy: { $in: candidates } },
      { landlordId: { $in: candidates } },
    ],
  };
}

/**
 * Build user owner filter with Administrator support
 * @param {Array} creatorCandidates - Array of user IDs from resolveCreatorScope
 * @returns {Object} MongoDB filter object
 */
function buildUserOwnerFilterWithScope(creatorCandidates) {
  if (!Array.isArray(creatorCandidates) || creatorCandidates.length === 0) {
    return {};
  }

  return {
    $or: [
      { createdBy: { $in: creatorCandidates } },
      { landlordId: { $in: creatorCandidates } },
    ],
  };
}

/**
 * build Application Owner Filter
 *
 * Performs logic operations for buildApplicationOwnerFilter.
 *
 * @param createdBy - Request/input argument
 * @returns Operations result
 */
function buildApplicationOwnerFilter(createdBy) {
  const candidates = sanitizeCandidates(toCreatorCandidates(createdBy));
  if (candidates.length === 0) {
    return {};
  }

  return {
    $or: [
      { createdBy: { $in: candidates } },
      { landlord_id: { $in: candidates } },
      { landlordId: { $in: candidates } },
    ],
  };
}

/**
 * Build application owner filter with Administrator support
 * @param {Array} creatorCandidates - Array of user IDs from resolveCreatorScope
 * @returns {Object} MongoDB filter object
 */
function buildApplicationOwnerFilterWithScope(creatorCandidates) {
  if (!Array.isArray(creatorCandidates) || creatorCandidates.length === 0) {
    return {};
  }

  return {
    $or: [
      { createdBy: { $in: creatorCandidates } },
      { landlord_id: { $in: creatorCandidates } },
      { landlordId: { $in: creatorCandidates } },
    ],
  };
}

function sanitizeCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    const oid = toObjectId(c);
    if (!oid) continue;
    const key = oid.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(oid);
  }
  return result;
}

async function findPropertiesByCreatedBy(PropertyModel, createdBy, projection = '_id') {
  if (!createdBy) {
    return [];
  }

  // If createdBy is an admin-scope object, expand to company user IDs
  if (typeof createdBy === 'object' && createdBy !== null && createdBy.isAdministrator) {
    const userId = toObjectId(createdBy.userId || createdBy._id || createdBy.id);
    const companyId = toObjectId(createdBy.companyId);
    const rawCandidates = await resolveCreatorScope(userId, true, companyId);
    const safeCandidates = sanitizeCandidates(rawCandidates);
    if (!safeCandidates.length) return [];
    let query = PropertyModel.find({
      ...buildPropertyOwnerFilterWithScope(safeCandidates),
      isDeleted: { $ne: true },
    }).lean();
    if (projection) query = query.select(projection);
    return query;
  }

  const safeCandidates = sanitizeCandidates(toCreatorCandidates(createdBy));
  if (!safeCandidates.length) return [];

  let query = PropertyModel.find({
    $or: [
      { createdBy: { $in: safeCandidates } },
      { landlord_id: { $in: safeCandidates } },
      { landlordId: { $in: safeCandidates } },
    ],
    isDeleted: { $ne: true },
  }).lean();

  if (projection) {
    query = query.select(projection);
  }

  return query;
}

async function findPropertyIdsByCreatedBy(PropertyModel, createdBy) {
  const properties = await findPropertiesByCreatedBy(PropertyModel, createdBy, '_id');
  return (properties || []).map((property) => property._id);
}

// Enhance buildPropertyOwnerFilter to accept admin-scope objects or candidate arrays
function buildPropertyOwnerFilter(createdBy) {
  // If caller passed an array of candidate ids, use scope filter
  if (Array.isArray(createdBy)) {
    return buildPropertyOwnerFilterWithScope(createdBy);
  }

  // If an admin-scope object was passed, build scope from it
  if (typeof createdBy === 'object' && createdBy !== null && createdBy.isAdministrator) {
    const userId = toObjectId(createdBy.userId || createdBy._id || createdBy.id);
    const companyId = toObjectId(createdBy.companyId);
    // Note: resolveCreatorScope returns array of candidates
    // We do this synchronously by returning a query fragment that consumers can await when used
    // But since this function must return an object, we will throw if used incorrectly.
    // Consumers should prefer findPropertiesByCreatedBy or findPropertyIdsByCreatedBy for admin objects.
    // As a best-effort fallback, return an empty filter so no results are matched unexpectedly.
    return {};
  }

  // Legacy behavior: string id
  const candidates = toCreatorCandidates(createdBy);
  if (candidates.length === 0) {
    return {};
  }

  return {
    $or: [
      { createdBy: { $in: candidates } },
      { landlord_id: { $in: candidates } },
      { landlordId: { $in: candidates } },
    ],
  };
}

function isEmptyFilter(filter) {
  return !filter || typeof filter !== 'object' || Object.keys(filter).length === 0;
}

function hoaExcludedClause() {
  return {
    $or: [
      { hoaId: null },
      { hoaId: { $exists: false } },
    ],
  };
}

function sourcePortalClause(sourcePortal) {
  if (
    sourcePortal !== PROPERTY_SOURCE_PORTAL.LANDLORD
    && sourcePortal !== PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER
  ) {
    return null;
  }

  return {
    $or: [
      { sourcePortal },
      { sourcePortal: null },
      { sourcePortal: { $exists: false } },
    ],
  };
}

/**
 * Expand createdBy (string, candidate array, or Administrator scope object) into a Mongo owner filter.
 * Unlike buildPropertyOwnerFilter, Administrator scope is resolved against company users instead of
 * returning an empty filter (which would match every property).
 */
async function resolvePropertyOwnerFilter(createdBy) {
  if (Array.isArray(createdBy)) {
    const candidates = sanitizeCandidates(createdBy);
    return candidates.length ? buildPropertyOwnerFilterWithScope(candidates) : MATCH_NO_DOCUMENTS;
  }

  if (createdBy && typeof createdBy === 'object' && createdBy.isAdministrator) {
    const userId = createdBy.userId || createdBy._id || createdBy.id;
    const companyId = createdBy.companyId || null;
    const rawCandidates = await resolveCreatorScope(userId, true, companyId);
    const candidates = sanitizeCandidates(rawCandidates);
    return candidates.length ? buildPropertyOwnerFilterWithScope(candidates) : MATCH_NO_DOCUMENTS;
  }

  const ownerFilter = buildPropertyOwnerFilter(createdBy);
  return isEmptyFilter(ownerFilter) ? MATCH_NO_DOCUMENTS : ownerFilter;
}

function combineLandlordPropertyVisibilityFilter(ownerFilter, sourcePortal) {
  if (isEmptyFilter(ownerFilter)) {
    return MATCH_NO_DOCUMENTS;
  }

  const parts = [ownerFilter, hoaExcludedClause()];
  const portalClause = sourcePortalClause(sourcePortal);
  if (portalClause) {
    parts.push(portalClause);
  }

  return { $and: parts };
}

/**
 * Landlord / Property Manager property visibility:
 * - owner/company scope
 * - exclude HOA-scoped properties (hoaId set)
 * - restrict to the caller's source portal (legacy untagged rows remain visible within owner scope)
 */
async function buildLandlordPropertyVisibilityFilter(createdBy, sourcePortal) {
  const ownerFilter = await resolvePropertyOwnerFilter(createdBy);
  return combineLandlordPropertyVisibilityFilter(ownerFilter, sourcePortal);
}

/**
 * Resolve which landlord-API portal created/should see properties.
 * Property Managers own a company distinct from the default PropMv company and JWT role is often Administrator.
 */
async function resolvePropertySourcePortal(user) {
  if (!user) return PROPERTY_SOURCE_PORTAL.LANDLORD;

  const role = String(user.role || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (role === 'landlord') {
    return PROPERTY_SOURCE_PORTAL.LANDLORD;
  }
  if (role === 'property manager') {
    return PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER;
  }

  if (user.companyId) {
    const { getPropMvCompany } = require('../../common/helpers/companyRoleHelper');
    const propMv = await getPropMvCompany();
    if (propMv && String(user.companyId) !== String(propMv._id)) {
      return PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER;
    }
  }

  if (user.isAdministrator) {
    return PROPERTY_SOURCE_PORTAL.PROPERTY_MANAGER;
  }

  return PROPERTY_SOURCE_PORTAL.LANDLORD;
}

module.exports = {
  buildApplicationOwnerFilter,
  buildPropertyOwnerFilter,
  buildUserOwnerFilter,
  findPropertiesByCreatedBy,
  findPropertyIdsByCreatedBy,
  requireCreatedBy,
  resolveCreatedBy,
  stripLegacyOwnerFields,
  // New enhanced functions
  resolveCreatorScope,
  buildPropertyOwnerFilterWithScope,
  buildUserOwnerFilterWithScope,
  buildApplicationOwnerFilterWithScope,
  resolvePropertyOwnerFilter,
  buildLandlordPropertyVisibilityFilter,
  resolvePropertySourcePortal,
  combineLandlordPropertyVisibilityFilter,
};
