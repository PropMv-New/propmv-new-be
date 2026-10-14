/**
 * ------------------------------------------------------------------
 * File: maintenanceCommentAccess.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceCommentAccess.
 *
 * Used By:
 * maintenance.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

const User = require('../../users/models/user.model');
const HOAMembership = require('../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const { isHOABoardMemberRole } = require('../../../../common/helpers/hoaBoardRole');
const { resolveUserRoleName } = require('../../../../common/helpers/companyRoleHelper');
const { LEASE_STATUSES } = require('../../../../common/constants/lease');

/**
 * to Id String
 *
 * Performs logic operations for toIdString.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function toIdString(id) {
  if (!id) return '';
  return id.toString ? id.toString() : String(id);
}

/**
 * maintenance Requested By User Ids
 *
 * Performs logic operations for maintenanceRequestedByUserIds.
 *
 * @param doc - Request/input argument
 * @returns Operations result
 */
function maintenanceRequestedByUserIds(doc) {
  if (!doc || !doc.requestedBy) return [];
  const rb = doc.requestedBy;
  if (Array.isArray(rb)) {
    return rb.map((x) => (x && x._id ? x._id : x)).filter(Boolean);
  }
  return [rb._id || rb].filter(Boolean);
}

async function userIsActiveHoaBoardMemberForHoa(userId, hoaId) {
  if (!userId || !hoaId) return false;

  const safeUserId = toObjectId(userId);
  const safeHoaId = toObjectId(hoaId);
  if (!safeUserId || !safeHoaId) return false;

  const membership = await HOAMembership.findOne({
    userId: safeUserId,
    hoaId: safeHoaId,
    status: 'active',
  }).lean();
  if (!membership) return false;

  const user = await User.findOne({ _id: safeUserId, isDeleted: { $ne: true } })
    .populate('role', 'name')
    .lean();
  return isHOABoardMemberRole(resolveUserRoleName(user));
}

async function userIsActiveTenantOnProperty(userId, propertyId) {
  if (!userId || !propertyId) return false;

  const Lease = require('../../../../portals/landlord/modules/leasing/model/lease.model');
  const safeUserId = toObjectId(userId);
  const safePropertyId = toObjectId(propertyId);
  if (!safeUserId || !safePropertyId) return false;

  const leases = await Lease.find({
    property_id: safePropertyId,
    status: { $in: [LEASE_STATUSES.APPROVED, LEASE_STATUSES.ACTIVE] },
    isDeleted: { $ne: true },
    'rentAndDepositDestribution.split.tenantId': safeUserId,
  })
    .select('_id')
    .limit(1)
    .lean();

  return leases.length > 0;
}

async function userIsHoaBoardMemberForTicket(userId, ticketHoaId, userContext = null) {
  if (!userId || !ticketHoaId) return false;

  if (
    userContext?.isHOABoardMember &&
    userContext?.hoaId &&
    toIdString(userContext.hoaId) === toIdString(ticketHoaId)
  ) {
    return true;
  }

  return userIsActiveHoaBoardMemberForHoa(userId, ticketHoaId);
}

/**
 * Returns true when the user is an authorized participant on the maintenance request.
 */
async function userCanParticipateInMaintenanceComments(request, userId, userContext = null) {
  if (!request || !userId) return false;

  const uid = toIdString(userId);
  const requesterIds = maintenanceRequestedByUserIds(request).map(toIdString);
  if (requesterIds.includes(uid)) return true;

  const assignedTo = request.assignedTo?._id || request.assignedTo;
  if (assignedTo && toIdString(assignedTo) === uid) return true;

  const createdBy = request.createdBy?._id || request.createdBy;
  if (createdBy && toIdString(createdBy) === uid) return true;

  const ticketHoaId = request.hoaId?._id || request.hoaId;
  if (ticketHoaId && await userIsHoaBoardMemberForTicket(userId, ticketHoaId, userContext)) {
    return true;
  }

  const propertyId = request.property_id?._id || request.property_id;
  const safePropertyId = toObjectId(propertyId);
  if (!safePropertyId) return false;

  const HOAProperty = require('../../../../portals/hoa-board/modules/property/model/property.model');
  const hoaProperty = await HOAProperty.findOne({
    _id: safePropertyId,
    isDeleted: { $ne: true },
  })
    .select('associatedOwnerIds hoaId createdBy')
    .lean();

  if (hoaProperty) {
    const ownerIds = Array.isArray(hoaProperty.associatedOwnerIds)
      ? hoaProperty.associatedOwnerIds.map(toIdString)
      : [];
    if (ownerIds.includes(uid)) return true;

    const propHoaId = request.hoaId || hoaProperty.hoaId;
    if (propHoaId && await userIsHoaBoardMemberForTicket(userId, propHoaId, userContext)) {
      return true;
    }
  }

  const LandlordProperty = require('../../../../portals/landlord/modules/property/model/property.model');
  const landlordProperty = await LandlordProperty.findOne({
    _id: safePropertyId,
    isDeleted: { $ne: true },
  })
    .select('createdBy landlord_id')
    .lean();

  if (landlordProperty?.createdBy && toIdString(landlordProperty.createdBy) === uid) {
    return true;
  }

  if (await userIsActiveTenantOnProperty(userId, propertyId)) {
    return true;
  }

  return false;
}

async function assertUserCanParticipateInMaintenanceComments(request, userId, userContext = null) {
  const allowed = await userCanParticipateInMaintenanceComments(request, userId, userContext);
  if (!allowed) {
    const err = new Error('You are not authorized to comment on this maintenance request');
    err.status = 403;
    throw err;
  }
}

module.exports = {
  maintenanceRequestedByUserIds,
  userCanParticipateInMaintenanceComments,
  assertUserCanParticipateInMaintenanceComments,
};
