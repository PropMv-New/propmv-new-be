/**
 * ------------------------------------------------------------------
 * File: maintenanceEmailRecipients.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceEmailRecipients.
 *
 * Used By:
 * maintenanceEmailHelper
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const User = require('../../shared/modules/users/models/user.model');

/**
 * normalize User Id
 *
 * Performs logic operations for normalizeUserId.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function normalizeUserId(value) {
  if (!value) return null;
  const id = value && typeof value === 'object' && value._id ? value._id : value;
  const str = String(id).trim();
  return mongoose.Types.ObjectId.isValid(str) ? str : null;
}

/**
 * normalize Requested By User Ids
 *
 * Performs logic operations for normalizeRequestedByUserIds.
 *
 * @param requestedBy - Request/input argument
 * @returns Operations result
 */
function normalizeRequestedByUserIds(requestedBy) {
  if (!requestedBy) return [];
  const values = Array.isArray(requestedBy) ? requestedBy : [requestedBy];
  const ids = [];
  for (const entry of values) {
    const id = normalizeUserId(entry);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * The requester must not receive any creation email when Notify Requester is off,
 * even when that user is also the creator, assignee, or board member.
 */
function shouldEmailMaintenanceRecipient(maintenanceRequest, userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return false;
  if (maintenanceRequest?.notifyTenant === true) return true;
  const requestedByIds = normalizeRequestedByUserIds(maintenanceRequest?.requestedBy);
  return !requestedByIds.some((id) => String(id) === normalizedUserId);
}

/** Same Notify Requester gate for in-app and update email recipient lists. */
function shouldNotifyMaintenanceRecipient(maintenanceRequest, userId) {
  return shouldEmailMaintenanceRecipient(maintenanceRequest, userId);
}

function filterMaintenanceNotifyUserIds(maintenanceRequest, userIds = []) {
  return [...new Set((userIds || []).map(normalizeUserId).filter(Boolean))]
    .filter((id) => shouldNotifyMaintenanceRecipient(maintenanceRequest, id));
}

/**
 * build Created Party Notifications
 *
 * Performs logic operations for buildCreatedPartyNotifications.
 *
 * @returns Operations result
 */
function buildCreatedPartyNotifications({
  creatorId = null,
  requestedByIds = [],
  createdByDisplay = null,
  requestedForDisplay = null,
  isSelfCreated = false,
} = {}) {
  const requestedSet = new Set(requestedByIds.map(String));
  const recipientIds = [];
  const seen = new Set();

  const pushId = (id) => {
    const key = String(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    recipientIds.push(key);
  };

  if (creatorId) pushId(creatorId);
  for (const id of requestedByIds) pushId(id);

  return recipientIds.map((userId) => {
    const isCreator = creatorId != null && String(creatorId) === userId;
    const isRequestedBy = requestedSet.has(userId);

    if (isCreator && isRequestedBy) {
      return {
        userId,
        eventKeyPrefix: 'maintenance_created',
        eventMessage: 'Your maintenance ticket was created successfully.',
        subjectSuffix: 'created',
      };
    }
    if (isCreator) {
      const onBehalf = requestedForDisplay ? ` on behalf of ${requestedForDisplay}` : '';
      return {
        userId,
        eventKeyPrefix: 'maintenance_created_creator',
        eventMessage: `You created a maintenance ticket${onBehalf}.`,
        subjectSuffix: 'created',
      };
    }
    if (isRequestedBy) {
      const creatorLabel = createdByDisplay || 'Someone';
      return {
        userId,
        eventKeyPrefix: 'maintenance_created_requested_by',
        eventMessage: isSelfCreated
          ? 'Your maintenance ticket was created successfully.'
          : `${creatorLabel} created a maintenance ticket on your behalf.`,
        subjectSuffix: 'created for you',
      };
    }
    return null;
  }).filter(Boolean);
}

async function loadMaintenancePartyUsers(userIds = []) {
  const validIds = [...new Set(userIds.map(String).filter((id) => id.length === 24 && mongoose.Types.ObjectId.isValid(id)))];
  if (!validIds.length) return [];

  return User.find({
    _id: { $in: validIds.map((id) => new mongoose.Types.ObjectId(id)) },
    isDeleted: { $ne: true },
    email: { $exists: true, $nin: [null, ''] },
  })
    .select('firstName lastName email')
    .lean();
}

module.exports = {
  normalizeUserId,
  normalizeRequestedByUserIds,
  shouldEmailMaintenanceRecipient,
  shouldNotifyMaintenanceRecipient,
  filterMaintenanceNotifyUserIds,
  buildCreatedPartyNotifications,
  loadMaintenancePartyUsers,
};
