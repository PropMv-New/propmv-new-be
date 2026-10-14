'use strict';

const mongoose = require('mongoose');
const { normalizeHoaId } = require('./payloadBillableMerchant.util');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * From HOA property rows, collect board member user ids (landlord_id) for units
 * where ownerUserId is a current owner.
 */
function collectHoaBoardMemberIdsForOwnerFromProperties(ownerUserId, properties, getCurrentOwnerIdsFromUnit) {
  const ownerStr = String(ownerUserId || '').trim();
  if (!ownerStr || typeof getCurrentOwnerIdsFromUnit !== 'function') {
    return [];
  }

  const boardMemberIds = new Set();
  for (const property of properties || []) {
    const currentOwners = getCurrentOwnerIdsFromUnit(property).map((id) => String(id));
    if (!currentOwners.includes(ownerStr)) continue;
    const landlordId = property?.landlord_id ?? property?.landlordId;
    if (landlordId) {
      boardMemberIds.add(String(landlordId));
    }
  }

  return [...boardMemberIds];
}

async function resolveHoaBoardMemberIdsForOwner(ownerUserId, hoaId) {
  const hoaIdStr = normalizeHoaId(hoaId);
  const ownerOid = toObjectId(ownerUserId);
  const hoaOid = toObjectId(hoaIdStr);
  if (!ownerOid || !hoaOid) return [];

  const Property = require('../../../../../../portals/hoa-board/modules/property/model/property.model');
  const { getCurrentOwnerIdsFromUnit } = require('../../../../../../portals/hoa-board/modules/owners/services/unit.service');

  const properties = await Property.find({
    hoaId: hoaOid,
    isDeleted: { $ne: true },
  })
    .select('landlord_id ownershipRecords associatedOwnerIds createdAt')
    .lean();

  return collectHoaBoardMemberIdsForOwnerFromProperties(
    ownerOid,
    properties,
    getCurrentOwnerIdsFromUnit,
  );
}

function boardMemberObjectIds(boardMemberIds = []) {
  return [...new Set((boardMemberIds || []).map((id) => String(id).trim()).filter(Boolean))]
    .map(toObjectId)
    .filter(Boolean);
}

module.exports = {
  collectHoaBoardMemberIdsForOwnerFromProperties,
  resolveHoaBoardMemberIdsForOwner,
  boardMemberObjectIds,
};
