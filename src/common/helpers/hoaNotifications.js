/**
 * HOA notification dispatcher.
 *
 * Rules:
 *  1. Board member action → notify all OTHER board members of the same community.
 *  2. Board member action on a property → notify the owner(s) of that property.
 *  3. Owner action → notify all board members of the owner's community and the owner.
 */

const { sendNotificationToMany } = require('./notificationHelper');

/**
 * Resolve active board member userIds for an HOA (excludes the actor).
 */
async function getBoardMemberIds(hoaId, excludeUserId) {
  if (!hoaId) return [];
  try {
    const { loadHoaMemberUserIds } = require('../../middleware/hoaDataIsolation');
    const ids = await loadHoaMemberUserIds(hoaId);
    return ids.filter((id) => !excludeUserId || id !== String(excludeUserId));
  } catch (err) {
    return [];
  }
}

/**
 * Resolve owner userIds for a property (associatedOwnerIds + User.propertyIds).
 */
async function getPropertyOwnerIds(propertyId) {
  if (!propertyId) return [];
  try {
    const { resolvePropertyOwnerUserIds } = require('./hoaRecipientResolver');
    return resolvePropertyOwnerUserIds(propertyId);
  } catch (err) {
    try {
      const Property = require('../../portals/hoa-board/modules/property/model/property.model');
      const prop = await Property.findById(propertyId).select('associatedOwnerIds').lean();
      return (prop?.associatedOwnerIds || []).map(String);
    } catch {
      return [];
    }
  }
}

/**
 * Resolve the hoaId for a property.
 */
async function getHoaIdForProperty(propertyId) {
  if (!propertyId) return null;
  try {
    const Property = require('../../portals/hoa-board/modules/property/model/property.model');
    const prop = await Property.findById(propertyId).select('hoaId').lean();
    return prop?.hoaId ? String(prop.hoaId) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Returns true when the user is an active board member of the HOA.
 */
async function isBoardMember(userId, hoaId) {
  if (!userId || !hoaId) return false;
  const ids = await getBoardMemberIds(hoaId, null);
  return ids.includes(String(userId));
}

/**
 * Notify all other board members when a board member performs an action.
 * Optionally also notify the owner(s) of the affected property.
 */
async function notifyBoardMemberAction({
  actorUserId,
  hoaId,
  propertyId,
  title,
  message,
  type = 'board_action',
  priority = 'medium',
  metadata = {},
  notifyOwner = false,
}) {
  const resolvedHoaId = hoaId || (propertyId ? await getHoaIdForProperty(propertyId) : null);

  const tasks = [];

  if (resolvedHoaId) {
    tasks.push(
      getBoardMemberIds(resolvedHoaId, actorUserId).then((ids) =>
        sendNotificationToMany(ids, { title, message, type, priority, metadata })
      )
    );
  }

  if (notifyOwner && propertyId) {
    tasks.push(
      getPropertyOwnerIds(propertyId).then((ids) =>
        sendNotificationToMany(
          ids.filter((id) => id !== String(actorUserId)),
          { title, message, type: 'owner_notice', priority, metadata }
        )
      )
    );
  }

  await Promise.all(tasks);
}

/**
 * Notify all board members when an owner performs an action.
 * The acting owner also receives a copy of the notification.
 */
async function notifyOwnerAction({
  ownerUserId,
  hoaId,
  title,
  message,
  type = 'owner_action',
  priority = 'medium',
  metadata = {},
}) {
  if (!hoaId) return;
  const boardMemberIds = await getBoardMemberIds(hoaId, null);
  const recipients = [...boardMemberIds];
  const ownerId = ownerUserId ? String(ownerUserId) : '';
  if (ownerId && !recipients.includes(ownerId)) {
    recipients.push(ownerId);
  }
  await sendNotificationToMany(recipients, { title, message, type, priority, metadata });
}

/**
 * Auto-route HOA notifications based on whether the actor is a board member or owner.
 */
async function dispatchHoaNotification({
  actorUserId,
  hoaId,
  propertyId,
  title,
  message,
  type = 'hoa_action',
  priority = 'medium',
  metadata = {},
  notifyOwner,
}) {
  if (!actorUserId || !hoaId) return;

  const actorIsBoard = await isBoardMember(actorUserId, hoaId);
  if (actorIsBoard) {
    await notifyBoardMemberAction({
      actorUserId,
      hoaId,
      propertyId,
      title,
      message,
      type,
      priority,
      metadata,
      notifyOwner: notifyOwner ?? Boolean(propertyId),
    });
    return;
  }

  await notifyOwnerAction({
    ownerUserId: actorUserId,
    hoaId,
    title,
    message,
    type,
    priority,
    metadata,
  });
}

module.exports = {
  notifyBoardMemberAction,
  notifyOwnerAction,
  dispatchHoaNotification,
  isBoardMember,
  getBoardMemberIds,
  getPropertyOwnerIds,
  getHoaIdForProperty,
};
