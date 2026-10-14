/**
 * ------------------------------------------------------------------
 * File: propertySearch.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * property.controller
 * ------------------------------------------------------------------
 */

const Property = require('../model/property.model');
const { getPropertiesService } = require('./property.service');
const {
  buildLandlordPropertyVisibilityFilter,
  resolveCreatorScope,
} = require('../../../../../shared/utils/creatorScope.util');

/**
 * format Address
 *
 * Performs logic operations for formatAddress.
 *
 * @param address - Request/input argument
 * @returns Operations result
 */
function formatAddress(address) {
  if (!address) return '';
  return `${address.street || ''}${address.street ? ', ' : ''}${address.city || ''}${address.city ? ', ' : ''}${address.state || ''}${address.zip ? ', ' : ''}${address.zip || ''}${address.country ? ', ' : ''}${address.country || ''}`
    .replace(/, \s*,/g, ', ')
    .trim();
}

/**
 * escape Regex
 *
 * Performs logic operations for escapeRegex.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * normalize Limit
 *
 * Performs logic operations for normalizeLimit.
 *
 * @param limit - Request/input argument
 * @param fallback - Request/input argument
 * @returns Operations result
 */
function normalizeLimit(limit, fallback) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 100);
}

async function searchPropertiesLiteService(text, createdBy, limit, sourcePortal) {
  const searchText = String(text || '').trim();
  const visibilityFilter = await buildLandlordPropertyVisibilityFilter(createdBy, sourcePortal);
  const filter = {
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
    ...visibilityFilter,
  };

  if (searchText) {
    const searchRegex = { $regex: escapeRegex(searchText), $options: 'i' };
    const searchCondition = {
      $or: [
        { name: searchRegex },
        { 'address.street': searchRegex },
        { 'address.city': searchRegex },
        { 'address.state': searchRegex },
        { 'address.zip': searchRegex },
        { 'address.country': searchRegex },
      ],
    };
    if (filter.$and) {
      filter.$and = [...filter.$and, searchCondition];
    } else if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, searchCondition];
      delete filter.$or;
    } else {
      Object.assign(filter, searchCondition);
    }
  }

  const properties = await Property.find(filter)
    .select('_id name address updatedAt createdAt')
    .sort(searchText ? { name: 1, updatedAt: -1 } : { updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  return {
    total: properties.length,
    page: 1,
    pagesize: limit,
    data: properties.map((property) => ({
      id: property._id,
      name: property.name,
      address: formatAddress(property.address),
    })),
  };
}

async function searchPropertiesService(text, createdBy, options = {}) {
  const limit = normalizeLimit(options.limit, options.lite ? 10 : 100);
  const sourcePortal = options.sourcePortal;

  if (options.lite) {
    return searchPropertiesLiteService(text, createdBy, limit, sourcePortal);
  }

  // For non-lite (full) searches, if createdBy is an admin-scope object, expand it to an array of candidates
  let createdByForQuery = createdBy;
  if (createdBy && typeof createdBy === 'object' && createdBy.isAdministrator) {
    const userId = createdBy.userId || createdBy._id || createdBy.id;
    const companyId = createdBy.companyId || null;
    const creatorCandidates = await resolveCreatorScope(userId, true, companyId);
    createdByForQuery = creatorCandidates;
  }

  return getPropertiesService({
    createdBy: createdByForQuery,
    sourcePortal,
    search: text,
    pageNumber: 1,
    pageSize: limit,
  });
}

module.exports = { searchPropertiesService };
