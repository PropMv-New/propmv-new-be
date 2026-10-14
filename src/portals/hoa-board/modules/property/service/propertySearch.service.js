/**
 * ------------------------------------------------------------------
 * File: propertySearch.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Lightweight property suggestions for the HOA board search box
 * (name, unit, address, and owner matches).
 *
 * Used By:
 * propertySearch.controller
 * ------------------------------------------------------------------
 */

const Property = require('../model/property.model');
const {
  applyHOADataFilter,
} = require('../../../../../middleware/hoaDataIsolation');
const {
  mergeFilterClauses,
} = require('./propertyPicker.service');
const {
  buildPropertyTextSearchClauseWithOwners,
  defaultEscapeRegex,
} = require('../helpers/propertyListSearch.helper');

/**
 * Lightweight property suggestions for the HOA board search box
 * (name, unit, address, and owner matches).
 * Scope by active HOA (x-hoa-id) for board members — not landlord_id alone —
 * so community properties created by other members remain searchable.
 */
async function searchPropertiesService(text, landlordId, userContext = null) {
  const baseFilter = {
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  };

  const hasHoaScope = Boolean(userContext?.hoaId || userContext?.isHOABoardMember);
  if (landlordId && !hasHoaScope) {
    baseFilter.landlord_id = landlordId;
  }

  let scopedFilter = applyHOADataFilter({ ...baseFilter }, userContext);

  const searchText = text && String(text).trim() ? String(text).trim() : '';
  if (searchText) {
    const textClause = await buildPropertyTextSearchClauseWithOwners(
      searchText,
      defaultEscapeRegex,
    );
    scopedFilter = mergeFilterClauses(scopedFilter, textClause);
  }

  const properties = await Property.find(scopedFilter, {
    name: 1,
    address: 1,
  })
    .limit(25)
    .lean();

  return properties.map((p) => ({
    id: p._id,
    name: p.name,
    address: p.address
      ? `${p.address.street || ''}, ${p.address.city || ''}, ${p.address.state || ''}`.trim()
      : '',
  }));
}

module.exports = { searchPropertiesService, escapeRegex: defaultEscapeRegex };
