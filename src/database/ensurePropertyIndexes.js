/**
 * ------------------------------------------------------------------
 * File: ensurePropertyIndexes.js
 * Module: Src Database
 *
 * Purpose:
 * Backend utility/module providing helper functions for ensurePropertyIndexes.
 *
 * Used By:
 * db.config
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const logger = require('../common/logger');

const LEGACY_INDEX_NAMES = new Set(['landlord_id_1_name_1', 'createdBy_1_name_1']);

const COMPOUND_KEYS = [
  { landlord_id: 1, name: 1, 'unitDetails.0.unitName': 1 },
  { createdBy: 1, name: 1, 'unitDetails.0.unitName': 1 },
];

/** Only active (non-deleted, non-archived) rows participate in uniqueness - allows reuse after archive/soft-delete. */
const ACTIVE_PROPERTY_PARTIAL = {
  isDeleted: { $ne: true },
  isArchieved: { $ne: true },
};

/**
 * is Legacy Two Field Name Unique Index
 *
 * Performs logic operations for isLegacyTwoFieldNameUniqueIndex.
 *
 * @param ix - Request/input argument
 * @returns Operations result
 */
function isLegacyTwoFieldNameUniqueIndex(ix) {
  if (!ix || !ix.key || !ix.unique) return false;
  const keys = Object.keys(ix.key);
  return (
    keys.length === 2 &&
    (ix.key.landlord_id === 1 || ix.key.createdBy === 1) &&
    ix.key.name === 1
  );
}

/**
 * is Name Unit Compound Key
 *
 * Performs logic operations for isNameUnitCompoundKey.
 *
 * @param key - Request/input argument
 * @returns Operations result
 */
function isNameUnitCompoundKey(key) {
  if (!key) return false;
  const hasOwner = key.landlord_id === 1 || key.createdBy === 1;
  return hasOwner && key.name === 1 && key['unitDetails.0.unitName'] === 1;
}

/**
 * partial Matches Active Property
 *
 * Performs logic operations for partialMatchesActiveProperty.
 *
 * @param ix - Request/input argument
 * @returns Operations result
 */
function partialMatchesActiveProperty(ix) {
  const pfe = ix && ix.partialFilterExpression;
  if (!pfe || typeof pfe !== 'object') return false;
  return (
    pfe.isDeleted &&
    pfe.isDeleted.$ne === true &&
    pfe.isArchieved &&
    pfe.isArchieved.$ne === true
  );
}

/**
 * keys Equal
 *
 * Performs logic operations for keysEqual.
 *
 * @param a - Request/input argument
 * @param b - Request/input argument
 * @returns Operations result
 */
function keysEqual(a, b) {
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/**
 * find Name Unit Unique Indexes
 *
 * Performs logic operations for findNameUnitUniqueIndexes.
 *
 * @param indexes - Request/input argument
 * @returns Operations result
 */
function findNameUnitUniqueIndexes(indexes) {
  return indexes.filter((ix) => ix && ix.unique && isNameUnitCompoundKey(ix.key));
}

/**
 * has Correct Partial Compound Unique Index
 *
 * Performs logic operations for hasCorrectPartialCompoundUniqueIndex.
 *
 * @param indexes - Request/input argument
 * @param compoundKey - Request/input argument
 * @returns Operations result
 */
function hasCorrectPartialCompoundUniqueIndex(indexes, compoundKey) {
  return findNameUnitUniqueIndexes(indexes).some(
    (ix) => keysEqual(ix.key, compoundKey) && partialMatchesActiveProperty(ix)
  );
}

/**
 * HOA stores many Property rows with the same community `name` (different units).
 * Legacy DBs still have unique(landlord_id, name) or unique(createdBy, name) which block reuse
 * after soft-delete - drop them and enforce partial unique(owner, name, first unit name) instead.
 */
async function ensurePropertyUniqueIndexes() {
  const db = mongoose.connection.db;
  if (!db) return;

  const coll = db.collection('properties');
  let indexes = await coll.indexes();

  for (const ix of indexes) {
    const shouldDrop =
      (ix.name && LEGACY_INDEX_NAMES.has(ix.name)) || isLegacyTwoFieldNameUniqueIndex(ix);
    if (!shouldDrop) continue;
    try {
      await coll.dropIndex(ix.name);
      logger.info(`[properties] Dropped legacy unique index`, { indexName: ix.name });
    } catch (e) {
      logger.warn(`[properties] Could not drop index`, { indexName: ix.name, error: e.message });
    }
  }

  indexes = await coll.indexes();
  const compoundUniques = findNameUnitUniqueIndexes(indexes);
  for (const ix of compoundUniques) {
    if (partialMatchesActiveProperty(ix)) continue;
    try {
      await coll.dropIndex(ix.name);
      logger.info(`[properties] Dropped unique compound index`, { indexName: ix.name });
    } catch (e) {
      logger.warn(`[properties] Could not drop index`, { indexName: ix.name, error: e.message });
    }
  }

  indexes = await coll.indexes();
  for (const compoundKey of COMPOUND_KEYS) {
    if (hasCorrectPartialCompoundUniqueIndex(indexes, compoundKey)) continue;
    await coll.createIndex(compoundKey, {
      unique: true,
      partialFilterExpression: ACTIVE_PROPERTY_PARTIAL,
    });
    const ownerField = compoundKey.landlord_id ? 'landlord_id' : 'createdBy';
    logger.info(`[properties] Created partial unique index`, { ownerField });
    indexes = await coll.indexes();
  }
}

module.exports = { ensurePropertyUniqueIndexes };
