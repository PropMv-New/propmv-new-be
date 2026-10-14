/**
 * ------------------------------------------------------------------
 * File: ensureUserEmailIndex.js
 * Module: Src Database
 *
 * Purpose:
 * Backend utility/module providing helper functions for ensureUserEmailIndex.
 *
 * Used By:
 * db.config
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const logger = require('../common/logger');

/** Active users only - soft-deleted rows may keep the same email for audit/history. */
const ACTIVE_USER_EMAIL_PARTIAL = {
  isDeleted: { $ne: true },
};

/**
 * is Global Email Unique Index
 *
 * Performs logic operations for isGlobalEmailUniqueIndex.
 *
 * @param ix - Request/input argument
 * @returns Operations result
 */
function isGlobalEmailUniqueIndex(ix) {
  if (!ix || !ix.unique || !ix.key) return false;
  const keys = Object.keys(ix.key);
  return keys.length === 1 && ix.key.email === 1 && !ix.partialFilterExpression;
}

/**
 * has Partial Email Unique Index
 *
 * Performs logic operations for hasPartialEmailUniqueIndex.
 *
 * @param indexes - Request/input argument
 * @returns Operations result
 */
function hasPartialEmailUniqueIndex(indexes) {
  return indexes.some((ix) => {
    if (!ix || !ix.unique || !ix.key || ix.key.email !== 1) return false;
    const pfe = ix.partialFilterExpression;
    return pfe && pfe.isDeleted && pfe.isDeleted.$ne === true;
  });
}

/**
 * Replace global unique(email) with partial unique(email) where isDeleted != true.
 * Allows soft-deleted owners to retain their original email without blocking reuse for new accounts.
 */
async function ensureUserEmailUniqueIndex() {
  const db = mongoose.connection.db;
  if (!db) return;

  const coll = db.collection('users');
  let indexes = await coll.indexes();

  for (const ix of indexes) {
    if (!isGlobalEmailUniqueIndex(ix)) continue;
    try {
      await coll.dropIndex(ix.name);
      logger.info('[users] Dropped legacy global unique email index', { indexName: ix.name });
    } catch (e) {
      logger.warn('[users] Could not drop index', { indexName: ix.name, error: e.message });
    }
  }

  indexes = await coll.indexes();
  if (!hasPartialEmailUniqueIndex(indexes)) {
    await coll.createIndex(
      { email: 1 },
      {
        unique: true,
        partialFilterExpression: ACTIVE_USER_EMAIL_PARTIAL,
      }
    );
    logger.info('[users] Created partial unique index on email (active users only)');
  }
}

module.exports = { ensureUserEmailUniqueIndex };
