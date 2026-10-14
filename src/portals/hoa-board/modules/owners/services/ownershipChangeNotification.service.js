const User = require('../../../../../shared/modules/users/models/user.model');
const { notify, EVENTS } = require('../../../../../common/notifications');
const logger = require('../../../../../common/logger');
const { formatDateInAppTimezone, billingCalendarDateKey } = require('../../../../../common/helpers/hoaBillingDates');
const { resolvePropertyScopedRecipients } = require('../../../../../common/helpers/hoaRecipientResolver');
const {
  sendOwnershipChangeScheduledEmails,
  sendOwnershipChangeEffectiveEmails,
  formatOwnerNames,
} = require('../../../../../common/helpers/ownershipChangeEmailHelper');
const { runHoaNotifyInBackground } = require('../../../../../common/helpers/hoaNotifyDispatch.helper');

function toIdString(value) {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value).trim();
}

function effectiveDateKey(effectiveDate) {
  return billingCalendarDateKey(effectiveDate) || '';
}

function buildOwnershipNotifyMetadata({
  unitId,
  property,
  effectiveDate,
  previousOwnerIds,
  newOwnerIds,
  phase,
}) {
  const effectiveKey = effectiveDateKey(effectiveDate);
  return {
    hoaId: property?.hoaId ? String(property.hoaId) : undefined,
    entityType: 'unit',
    entityId: String(unitId),
    propertyId: String(unitId),
    phase,
    effectiveDate: effectiveDate instanceof Date ? effectiveDate.toISOString() : effectiveDate,
    effectiveDateKey: effectiveKey,
    previousOwnerIds: (previousOwnerIds || []).map(String),
    newOwnerIds: (newOwnerIds || []).map(String),
  };
}

async function loadRecipientUsers(recipientIds = []) {
  const ids = [...new Set((recipientIds || []).map(toIdString).filter(Boolean))];
  if (!ids.length) return [];
  return User.find({
    _id: { $in: ids },
    isDeleted: { $ne: true },
  })
    .select('_id firstName lastName email')
    .lean();
}

async function resolveOwnershipChangeRecipientIds({
  property,
  unitId,
  previousOwnerIds = [],
  newOwnerIds = [],
  performedBy = null,
}) {
  return resolvePropertyScopedRecipients({
    hoaId: property?.hoaId,
    propertyId: unitId,
    actorUserId: performedBy,
    extraOwnerIds: [...previousOwnerIds, ...newOwnerIds],
  });
}

function unitDisplayLabel(property = {}) {
  const unitName = property?.unitDetails?.[0]?.unitName;
  return unitName ? `${property?.name || 'Property'} · ${unitName}` : (property?.name || 'Property');
}

async function notifyOwnershipChangeScheduled({
  unitId,
  property,
  previousOwnerIds = [],
  newOwnerIds = [],
  effectiveDate,
  performedBy = null,
  balanceResetSettlement = null,
}) {
  const recipientIds = await resolveOwnershipChangeRecipientIds({
    property,
    unitId,
    previousOwnerIds,
    newOwnerIds,
    performedBy,
  });
  if (!recipientIds.length) return { sent: 0 };

  const [recipients, previousOwners, newOwners] = await Promise.all([
    loadRecipientUsers(recipientIds),
    loadRecipientUsers(previousOwnerIds),
    loadRecipientUsers(newOwnerIds),
  ]);

  const effectiveKey = effectiveDateKey(effectiveDate);
  const effectiveDateLabel = effectiveDate
    ? formatDateInAppTimezone(effectiveDate, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const metadata = buildOwnershipNotifyMetadata({
    unitId,
    property,
    effectiveDate,
    previousOwnerIds,
    newOwnerIds,
    phase: 'scheduled',
  });

  await notify(
    EVENTS.OWNERSHIP_CHANGE_SCHEDULED,
    {
      propertyName: property?.name || 'Property',
      unitName: property?.unitDetails?.[0]?.unitName || 'Unit',
      unitLabel: unitDisplayLabel(property),
      currentOwnerNames: formatOwnerNames(previousOwners),
      futureOwnerNames: formatOwnerNames(newOwners),
      effectiveDateLabel,
    },
    recipientIds,
    metadata,
    { idempotencyKey: `ownership_change_scheduled:${unitId}:${effectiveKey}` }
  );

  await sendOwnershipChangeScheduledEmails({
    recipients,
    property,
    previousOwnerIds,
    newOwnerIds,
    effectiveDate,
    performedBy,
    balanceResetSettlement,
  });

  return { sent: recipientIds.length };
}

async function notifyOwnershipChangeEffective({
  unitId,
  property,
  previousOwnerIds = [],
  newOwnerIds = [],
  effectiveDate,
  performedBy = null,
  balanceResetSettlement = null,
}) {
  const recipientIds = await resolveOwnershipChangeRecipientIds({
    property,
    unitId,
    previousOwnerIds,
    newOwnerIds,
    performedBy,
  });
  if (!recipientIds.length) return { sent: 0 };

  const [recipients, previousOwners, newOwners] = await Promise.all([
    loadRecipientUsers(recipientIds),
    loadRecipientUsers(previousOwnerIds),
    loadRecipientUsers(newOwnerIds),
  ]);

  const effectiveKey = effectiveDateKey(effectiveDate);
  const effectiveDateLabel = effectiveDate
    ? formatDateInAppTimezone(effectiveDate, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const metadata = buildOwnershipNotifyMetadata({
    unitId,
    property,
    effectiveDate,
    previousOwnerIds,
    newOwnerIds,
    phase: 'effective',
  });

  await notify(
    EVENTS.OWNERSHIP_CHANGE_EFFECTIVE,
    {
      propertyName: property?.name || 'Property',
      unitName: property?.unitDetails?.[0]?.unitName || 'Unit',
      unitLabel: unitDisplayLabel(property),
      previousOwnerNames: formatOwnerNames(previousOwners),
      newOwnerNames: formatOwnerNames(newOwners),
      effectiveDateLabel,
    },
    recipientIds,
    metadata,
    { idempotencyKey: `ownership_change_effective:${unitId}:${effectiveKey}` }
  );

  await sendOwnershipChangeEffectiveEmails({
    recipients,
    property,
    previousOwnerIds,
    newOwnerIds,
    effectiveDate,
    performedBy,
    balanceResetSettlement,
  });

  return { sent: recipientIds.length };
}

function queueOwnershipChangeScheduledNotification(payload) {
  runHoaNotifyInBackground(
    () => notifyOwnershipChangeScheduled(payload),
    'ownership change scheduled notify'
  );
}

function queueOwnershipChangeEffectiveNotification(payload) {
  runHoaNotifyInBackground(
    () => notifyOwnershipChangeEffective(payload),
    'ownership change effective notify'
  );
}

module.exports = {
  notifyOwnershipChangeScheduled,
  notifyOwnershipChangeEffective,
  queueOwnershipChangeScheduledNotification,
  queueOwnershipChangeEffectiveNotification,
  effectiveDateKey,
  resolveOwnershipChangeRecipientIds,
};
