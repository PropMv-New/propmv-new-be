/**
 * ------------------------------------------------------------------
 * File: propertyPicker.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * propertySearch.controller
 * ------------------------------------------------------------------
 */

const Property = require('../model/property.model');
const {
  applyHOADataFilter,
  buildActiveHoaIdMatch,
} = require('../../../../../middleware/hoaDataIsolation');

function buildTextSearchClause(text) {
  if (!text || !String(text).trim()) return null;
  const searchRegex = { $regex: String(text).trim(), $options: 'i' };
  return {
    $or: [
      { name: searchRegex },
      { 'unitDetails.unitName': searchRegex },
      { 'address.street': searchRegex },
      { 'address.city': searchRegex },
      { 'address.state': searchRegex },
      { 'address.zip': searchRegex },
    ],
  };
}

function buildOwnerPropertyPickerClause(userContext) {
  if (!userContext?.isHOAOwner || !userContext?.userId) return null;

  const uid = userContext.userId;
  const ownerConditions = [{ associatedOwnerIds: uid }];

  const propertyIds = Array.isArray(userContext.ownerPropertyIds)
    ? userContext.ownerPropertyIds.filter(Boolean)
    : [];
  if (propertyIds.length) {
    ownerConditions.push({ _id: { $in: propertyIds } });
  }

  const clauses = [{ $or: ownerConditions }];
  const hoaMatch = buildActiveHoaIdMatch(userContext);
  if (hoaMatch) clauses.unshift(hoaMatch);

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function mergeFilterClauses(...clauses) {
  const active = clauses.filter(Boolean);
  if (active.length === 0) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

/**
 * Lightweight property rows for dropdowns / invoice forms.
 */
async function listPropertiesPickerService({
  text = '',
  landlordId,
  limit = 50,
  userContext = null,
}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const baseFilter = {
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  };

  // HOA board requests are scoped by hoaContext (x-hoa-id). Applying landlord_id on top
  // would hide community properties created by other board members.
  const hasHoaScope = Boolean(userContext?.hoaId || userContext?.isHOABoardMember);
  if (landlordId && !hasHoaScope) {
    baseFilter.landlord_id = landlordId;
  }

  let scopedFilter = applyHOADataFilter({ ...baseFilter }, userContext);
  const ownerClause = buildOwnerPropertyPickerClause(userContext);
  const textClause = buildTextSearchClause(text);
  const filter = mergeFilterClauses(scopedFilter, ownerClause, textClause);

  const properties = await Property.find(filter, { name: 1, unitDetails: 1, address: 1 })
    .sort({ name: 1 })
    .limit(cap)
    .lean();

  return properties.map((p) => ({
    _id: p._id,
    id: p._id,
    name: p.name,
    unitDetails: p.unitDetails || [],
    address: p.address,
  }));
}

module.exports = {
  listPropertiesPickerService,
  buildOwnerPropertyPickerClause,
  mergeFilterClauses,
};
