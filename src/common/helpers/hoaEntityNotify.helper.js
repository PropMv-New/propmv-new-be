/**
 * HOA entity notifications (property, owner) via the unified notify() pipeline.
 */

const { EVENTS } = require('../notifications');
const {
  resolvePropertyNotificationRecipients,
  resolveOwnerNotificationRecipients,
  resolveHoaIdFromProperty,
  toIdString,
} = require('./hoaRecipientResolver');
const logger = require('../logger');
const {
  runHoaNotifyInBackground,
  dispatchHoaInAppNotification,
} = require('./hoaNotifyDispatch.helper');

function notify(event, data, recipients, metadata = {}, options = {}) {
  return dispatchHoaInAppNotification(event, data, recipients, metadata, options);
}

function runInBackground(task, label = 'entity notify') {
  runHoaNotifyInBackground(task, label);
}

function enqueueEntityNotify(handler, payload, run, extra = {}) {
  runHoaNotifyInBackground(run, handler || extra.entityType || 'entity notify');
}

function buildHoaMetadata(hoaId, entityType, entityId, extra = {}) {
  return {
    hoaId: hoaId ? String(hoaId) : undefined,
    entityType,
    entityId: entityId ? String(entityId) : undefined,
    ...extra,
  };
}

function ownerIdsFromProperty(property) {
  const raw = property?.associatedOwnerIds || property?.ownerIds || [];
  return Array.isArray(raw) ? raw.map(toIdString).filter(Boolean) : [];
}

async function notifyPropertyCreatedInApp(property, actorUserId = null) {
  const hoaId = toIdString(property?.hoaId);
  const propertyId = toIdString(property?._id);
  const ownerIds = ownerIdsFromProperty(property);
  // No owners → board-only (or empty if no board). Matches "no owner → no owner notification".
  const recipients = await resolvePropertyNotificationRecipients({
    hoaId,
    propertyId,
    actorUserId,
    ownerIds,
  });
  if (!recipients.length) return { sent: 0 };

  await notify(
    EVENTS.PROPERTY_CREATED,
    { propertyName: property?.name || 'Property' },
    recipients,
    buildHoaMetadata(hoaId, 'property', propertyId, { propertyId }),
    { idempotencyKey: `property_created:${propertyId}` }
  );
  return { sent: recipients.length };
}

async function notifyPropertyUpdatedInApp(property, actorUserId = null) {
  const hoaId = toIdString(property?.hoaId);
  const propertyId = toIdString(property?._id);
  const ownerIds = ownerIdsFromProperty(property);
  const recipients = await resolvePropertyNotificationRecipients({
    hoaId,
    propertyId,
    actorUserId,
    ownerIds,
  });
  if (!recipients.length) return { sent: 0 };

  await notify(
    EVENTS.PROPERTY_UPDATED,
    { propertyName: property?.name || 'Property' },
    recipients,
    buildHoaMetadata(hoaId, 'property', propertyId, { propertyId }),
    { idempotencyKey: `property_updated:${propertyId}:${property?.updatedAt || Date.now()}` }
  );
  return { sent: recipients.length };
}

async function notifyPropertyDeletedInApp({
  hoaId,
  propertyId,
  propertyName = 'Property',
  ownerIds = null,
}, actorUserId = null) {
  const recipients = await resolvePropertyNotificationRecipients({
    hoaId,
    propertyId,
    actorUserId,
    ownerIds,
  });
  if (!recipients.length) return { sent: 0 };

  await notify(
    EVENTS.PROPERTY_DELETED,
    { propertyName },
    recipients,
    buildHoaMetadata(hoaId, 'property', propertyId, { propertyId }),
    { idempotencyKey: `property_deleted:${propertyId}` }
  );
  return { sent: recipients.length };
}

async function notifyOwnerCreatedInApp(owner, actorUserId = null, hoaId = null) {
  const resolvedHoaId = toIdString(hoaId || owner?.hoaId);
  const ownerUserId = toIdString(owner?._id);
  const ownerName = `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim() || 'Owner';
  const recipients = await resolveOwnerNotificationRecipients({
    hoaId: resolvedHoaId,
    ownerUserId,
    actorUserId,
  });
  if (!recipients.length) return { sent: 0 };

  await notify(
    EVENTS.OWNER_CREATED,
    { ownerName },
    recipients,
    buildHoaMetadata(resolvedHoaId, 'owner', ownerUserId, { ownerId: ownerUserId }),
    { idempotencyKey: `owner_created:${ownerUserId}` }
  );
  return { sent: recipients.length };
}

async function notifyOwnerUpdatedInApp(owner, actorUserId = null, hoaId = null) {
  const resolvedHoaId = toIdString(hoaId || owner?.hoaId);
  const ownerUserId = toIdString(owner?._id);
  const ownerName = `${owner?.firstName || ''} ${owner?.lastName || ''}`.trim() || 'Owner';
  const recipients = await resolveOwnerNotificationRecipients({
    hoaId: resolvedHoaId,
    ownerUserId,
    actorUserId,
  });
  if (!recipients.length) return { sent: 0 };

  await notify(
    EVENTS.OWNER_UPDATED,
    { ownerName },
    recipients,
    buildHoaMetadata(resolvedHoaId, 'owner', ownerUserId, { ownerId: ownerUserId }),
    { idempotencyKey: `owner_updated:${ownerUserId}:${Date.now()}` }
  );
  return { sent: recipients.length };
}

async function notifyOwnerArchivedInApp({ ownerUserId, ownerName = 'Owner', hoaId }, actorUserId = null) {
  const recipients = await resolveOwnerNotificationRecipients({
    hoaId,
    ownerUserId,
    actorUserId,
  });
  if (!recipients.length) return { sent: 0 };

  await notify(
    EVENTS.OWNER_ARCHIVED,
    { ownerName },
    recipients,
    buildHoaMetadata(hoaId, 'owner', ownerUserId, { ownerId: ownerUserId }),
    { idempotencyKey: `owner_archived:${ownerUserId}` }
  );
  return { sent: recipients.length };
}

async function notifyOwnerDeletedInApp({
  ownerUserId,
  ownerName = 'Owner',
  hoaId,
  propertyId = null,
  unitName = null,
} = {}, actorUserId = null) {
  const resolvedHoaId = toIdString(hoaId)
    || (propertyId ? await resolveHoaIdFromProperty(propertyId) : '');
  const recipients = await resolveOwnerNotificationRecipients({
    hoaId: resolvedHoaId,
    ownerUserId,
    actorUserId,
  });
  if (!recipients.length) return { sent: 0 };

  const scopeKey = toIdString(propertyId) || 'community';
  await notify(
    EVENTS.OWNER_DELETED,
    { ownerName, unitName: unitName || undefined },
    recipients,
    buildHoaMetadata(resolvedHoaId, 'owner', ownerUserId, {
      ownerId: ownerUserId,
      propertyId: propertyId ? toIdString(propertyId) : undefined,
    }),
    { idempotencyKey: `owner_deleted:${ownerUserId}:${scopeKey}:${Date.now()}` }
  );
  return { sent: recipients.length };
}

function notifyPropertyCreatedInAppInBackground(property, actorUserId = null) {
  enqueueEntityNotify(
    'property_created',
    { property, actorUserId },
    () => notifyPropertyCreatedInApp(property, actorUserId),
    {
      entityType: 'property',
      entityId: toIdString(property?._id),
      idempotencyKey: `property_created:${toIdString(property?._id)}`,
    }
  );
}

function notifyPropertyUpdatedInAppInBackground(property, actorUserId = null) {
  enqueueEntityNotify(
    'property_updated',
    { property, actorUserId },
    () => notifyPropertyUpdatedInApp(property, actorUserId),
    {
      entityType: 'property',
      entityId: toIdString(property?._id),
      idempotencyKey: `property_updated:${toIdString(property?._id)}:${property?.updatedAt || ''}`,
    }
  );
}

function notifyPropertyDeletedInAppInBackground(payload, actorUserId = null) {
  enqueueEntityNotify(
    'property_deleted',
    { ...payload, actorUserId },
    () => notifyPropertyDeletedInApp(payload, actorUserId),
    {
      entityType: 'property',
      entityId: payload?.propertyId || '',
      idempotencyKey: `property_deleted:${payload?.propertyId || ''}`,
    }
  );
}

function notifyOwnerCreatedInAppInBackground(owner, actorUserId = null, hoaId = null) {
  enqueueEntityNotify(
    'owner_created',
    { owner, actorUserId, hoaId },
    () => notifyOwnerCreatedInApp(owner, actorUserId, hoaId),
    {
      entityType: 'owner',
      entityId: toIdString(owner?._id),
      idempotencyKey: `owner_created:${toIdString(owner?._id)}`,
    }
  );
}

function notifyOwnerUpdatedInAppInBackground(owner, actorUserId = null, hoaId = null) {
  enqueueEntityNotify(
    'owner_updated',
    { owner, actorUserId, hoaId },
    () => notifyOwnerUpdatedInApp(owner, actorUserId, hoaId),
    {
      entityType: 'owner',
      entityId: toIdString(owner?._id),
      idempotencyKey: `owner_updated:${toIdString(owner?._id)}:${owner?.updatedAt || ''}`,
    }
  );
}

function notifyOwnerArchivedInAppInBackground(payload, actorUserId = null) {
  enqueueEntityNotify(
    'owner_archived',
    { ...payload, actorUserId },
    () => notifyOwnerArchivedInApp(payload, actorUserId),
    {
      entityType: 'owner',
      entityId: payload?.ownerId || toIdString(payload?._id),
      idempotencyKey: `owner_archived:${payload?.ownerId || toIdString(payload?._id)}`,
    }
  );
}

function notifyOwnerDeletedInAppInBackground(payload, actorUserId = null) {
  const ownerKey = payload?.ownerUserId || payload?.ownerId || toIdString(payload?._id);
  const scopeKey = toIdString(payload?.propertyId) || 'community';
  enqueueEntityNotify(
    'owner_deleted',
    { ...payload, actorUserId },
    () => notifyOwnerDeletedInApp(payload, actorUserId),
    {
      entityType: 'owner',
      entityId: ownerKey,
      idempotencyKey: `owner_deleted:${ownerKey}:${scopeKey}`,
    }
  );
}

module.exports = {
  notifyPropertyCreatedInApp,
  notifyPropertyUpdatedInApp,
  notifyPropertyDeletedInApp,
  notifyOwnerCreatedInApp,
  notifyOwnerUpdatedInApp,
  notifyOwnerArchivedInApp,
  notifyOwnerDeletedInApp,
  notifyPropertyCreatedInAppInBackground,
  notifyPropertyUpdatedInAppInBackground,
  notifyPropertyDeletedInAppInBackground,
  notifyOwnerCreatedInAppInBackground,
  notifyOwnerUpdatedInAppInBackground,
  notifyOwnerArchivedInAppInBackground,
  notifyOwnerDeletedInAppInBackground,
};
