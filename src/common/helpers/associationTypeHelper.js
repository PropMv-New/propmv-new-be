/**
 * ------------------------------------------------------------------
 * File: associationTypeHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for associationTypeHelper.
 *
 * Used By:
 * masterData.service
 * ------------------------------------------------------------------
 */

const MasterData = require('../../shared/modules/master/model/masterData.model');
const { MASTER_DATA_KEYS } = require('../constants/masterDataKeys');

/** Fallback when masterdata is not seeded yet - keeps legacy signups working. */
const LEGACY_ASSOCIATION_TYPE_VALUES = [
  'Condo',
  'Apartment',
  'Villa',
  'Townhouse',
  'Single Family Homes',
  'Land',
];

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedValues = null;
let cacheExpiresAt = 0;

/**
 * extract Values
 *
 * Performs logic operations for extractValues.
 *
 * @param record - Request/input argument
 * @returns Operations result
 */
function extractValues(record) {
  if (!record?.data || !Array.isArray(record.data)) return [];
  return record.data
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        return String(item.value ?? item.label ?? '').trim();
      }
      return '';
    })
    .filter(Boolean);
}

async function getAllowedAssociationTypeValues({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedValues && now < cacheExpiresAt) {
    return cachedValues;
  }

  try {
    const record = await MasterData.findOne({ key: MASTER_DATA_KEYS.HOA_ASSOCIATION_TYPES }).lean();
    const values = extractValues(record);
    cachedValues = values.length > 0 ? values : LEGACY_ASSOCIATION_TYPE_VALUES;
  } catch {
    cachedValues = LEGACY_ASSOCIATION_TYPE_VALUES;
  }

  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedValues;
}

async function isValidAssociationType(value) {
  if (value == null || value === '') return true;
  const allowed = await getAllowedAssociationTypeValues();
  return allowed.includes(String(value).trim());
}

/**
 * clear Association Type Cache
 *
 * Performs logic operations for clearAssociationTypeCache.
 *
 * @returns Operations result
 */
function clearAssociationTypeCache() {
  cachedValues = null;
  cacheExpiresAt = 0;
}

module.exports = {
  getAllowedAssociationTypeValues,
  isValidAssociationType,
  clearAssociationTypeCache,
  LEGACY_ASSOCIATION_TYPE_VALUES,
};
