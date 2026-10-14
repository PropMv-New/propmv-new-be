/**
 * ------------------------------------------------------------------
 * File: hoaPropertyScope.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaPropertyScope.
 *
 * Used By:
 * dashboard.service, expense.service, invoice.service, maintenance.service
 * ------------------------------------------------------------------
 */

/**
 * Resolve HOA-scoped property IDs once per request (cached on req.hoaContext.propertyIds).
 */
const mongoose = require('mongoose');
const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const Invoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const { buildHoaBoardPropertyMatch } = require('../../middleware/hoaDataIsolation');

/**
 * get Cached Hoa Property Ids
 *
 * Performs logic operations for getCachedHoaPropertyIds.
 *
 * @param userContext - Request/input argument
 * @returns Operations result
 */
function getCachedHoaPropertyIds(userContext) {
  if (!userContext?.isHOABoardMember) return null;
  if (Array.isArray(userContext.propertyIds)) {
    return userContext.propertyIds;
  }
  return undefined;
}

/**
 * @param {Object|null} userContext - req.hoaContext
 * @returns {Promise<import('mongoose').Types.ObjectId[]|null>} null when not an HOA board member
 */
async function resolveHoaPropertyIds(userContext) {
  if (!userContext?.isHOABoardMember) return null;

  const cached = getCachedHoaPropertyIds(userContext);
  if (cached !== undefined) return cached;

  const hoaMatch = buildHoaBoardPropertyMatch(userContext);
  if (!hoaMatch) return [];

  const props = await Property.find(hoaMatch).select('_id').lean();
  const ids = props.map((p) => p._id);
  userContext.propertyIds = ids;
  return ids;
}

/**
 * Property IDs an HOA owner may see invoices for: active assigned units plus any unit
 * with non-deleted invoices where they are the payer (preserves history after unit deletion).
 *
 * @param {string|import('mongoose').Types.ObjectId} ownerId
 * @param {Array<string|import('mongoose').Types.ObjectId>|null} [requestedPropertyIds]
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
async function resolveHoaOwnerInvoicePropertyIds(ownerId, requestedPropertyIds = null) {
  const ownerOid = mongoose.Types.ObjectId.isValid(String(ownerId))
    ? new mongoose.Types.ObjectId(String(ownerId))
    : ownerId;

  const activeProps = await Property.find({
    associatedOwnerIds: ownerOid,
    isDeleted: { $ne: true },
  })
    .select('_id')
    .lean();

  const historicalIds = await Invoice.distinct('propertyId', {
    tenants: ownerOid,
    isDeleted: { $ne: true },
    generatedFrom: { $ne: 'late_fee' },
  });

  const merged = new Map();
  for (const p of activeProps) merged.set(String(p._id), p._id);
  for (const id of historicalIds) {
    if (id) merged.set(String(id), id);
  }

  let ids = Array.from(merged.values());

  if (requestedPropertyIds && requestedPropertyIds.length > 0) {
    const requested = new Set(requestedPropertyIds.map((id) => String(id)));
    ids = ids.filter((id) => requested.has(String(id)));
  }

  return ids;
}

module.exports = {
  resolveHoaPropertyIds,
  resolveHoaOwnerInvoicePropertyIds,
  getCachedHoaPropertyIds,
};
