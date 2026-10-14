/**
 * Centralized HOA notification recipient resolution.
 *
 * Rules:
 *  - Community actions → ALL active board members (including the actor).
 *  - Property-scoped actions → ALL board members + ALL owners linked to the property
 *    (including an owner who performed the action).
 *  - Owner CRUD → all board members + the affected owner (including when the owner is the actor).
 *  - Vendors are standalone: they receive maintenance + vendor-invoice (vendor portal)
 *    notices only — never property/owner/invoice/expense/document community broadcasts
 *    just because they are associated with the HOA or assigned on a ticket's property.
 *  - Per-user read/unread: notify() creates one record per recipient.
 */

const mongoose = require('mongoose');
const { loadHoaMemberUserIds } = require('../../middleware/hoaDataIsolation');
const { resolveInvoicePayerUsers } = require('./invoiceNotificationEmailHelper');

function toIdString(value) {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value).trim();
}

function toObjectId(value) {
  const str = toIdString(value);
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function dedupeIds(ids = []) {
  return [...new Set(ids.map(toIdString).filter(Boolean))];
}

function excludeActor(ids = [], actorUserId = null) {
  const actor = toIdString(actorUserId);
  if (!actor) return dedupeIds(ids);
  return dedupeIds(ids).filter((id) => id !== actor);
}

/**
 * Strip Vendor-role users from a recipient list.
 * Used for HOA modules that are not part of the vendor portal surface.
 */
async function excludeVendorUserIds(userIds = []) {
  const ids = dedupeIds(userIds);
  if (!ids.length) return [];

  try {
    const User = require('../../shared/modules/users/models/user.model');
    const { buildVendorUserFilter } = require('./hoaVendorRole');
    const oids = ids
      .filter((id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24)
      .map((id) => new mongoose.Types.ObjectId(id));
    if (!oids.length) return ids;

    const filter = await buildVendorUserFilter({
      _id: { $in: oids },
      isDeleted: { $ne: true },
    });
    const vendors = await User.find(filter).select('_id').lean();
    if (!vendors.length) return ids;
    const vendorSet = new Set(vendors.map((v) => toIdString(v._id)));
    return ids.filter((id) => !vendorSet.has(id));
  } catch {
    // If Vendor role lookup fails, keep recipients (do not drop board/owners).
    return ids;
  }
}

/**
 * All active board members for an HOA (actor included for independent read state).
 */
async function resolveBoardMemberIds(hoaId, _actorUserId = null) {
  if (!hoaId) return [];
  return dedupeIds(await loadHoaMemberUserIds(hoaId));
}

/**
 * Resolve owner user IDs for a property/unit.
 * Uses associatedOwnerIds plus User.propertyIds (HOA units store owners on the unit).
 */
async function resolvePropertyOwnerUserIds(propertyRef) {
  const propertyId = toIdString(
    propertyRef && typeof propertyRef === 'object' && propertyRef._id
      ? propertyRef._id
      : propertyRef
  );
  if (!propertyId) return [];

  const fromProperty = [];
  const propObjId = toObjectId(propertyId);
  try {
    const Property = require('../../portals/hoa-board/modules/property/model/property.model');
    const { getCurrentOwnerIdsFromUnit } = require('../../portals/hoa-board/modules/owners/services/unit.service');
    const prop = propObjId
      ? await Property.findById(propObjId).select('associatedOwnerIds ownershipRecords createdAt').lean()
      : null;
    if (prop) {
      const timelineOwners = getCurrentOwnerIdsFromUnit(prop);
      if (timelineOwners.length > 0) return dedupeIds(timelineOwners);
    }
    for (const id of prop?.associatedOwnerIds || []) {
      fromProperty.push(toIdString(id));
    }
  } catch {
    // fall through to User.propertyIds
  }

  if (!propObjId) return dedupeIds(fromProperty);

  try {
    const User = require('../../shared/modules/users/models/user.model');
    const linked = await User.find({
      propertyIds: propObjId,
      isDeleted: { $ne: true },
    })
      .select('_id')
      .lean();
    return dedupeIds([
      ...fromProperty,
      ...linked.map((u) => toIdString(u._id)),
    ]);
  } catch {
    return dedupeIds(fromProperty);
  }
}

async function resolveHoaIdFromProperty(propertyRef) {
  const propertyId = toObjectId(propertyRef);
  if (!propertyId) return '';
  try {
    const Property = require('../../portals/hoa-board/modules/property/model/property.model');
    const prop = await Property.findOne({ _id: { $eq: propertyId }, isDeleted: { $ne: true } })
      .select('hoaId')
      .lean();
    return prop?.hoaId ? toIdString(prop.hoaId) : '';
  } catch {
    return '';
  }
}

function resolveExpensePropertyId(expense = {}) {
  return toIdString(
    expense.propertyId
    || expense.property
    || (expense.property && expense.property._id)
  );
}

function resolveExpenseHoaId(expense = {}) {
  return toIdString(expense.hoaId) || '';
}

/**
 * Merge all board members with affected owners/payers.
 * The acting owner is included so they also see the notification for their own action.
 */
function mergeBoardAndAffected(boardIds, affectedIds, _actorUserId = null) {
  return dedupeIds([
    ...boardIds,
    ...(affectedIds || []),
  ]);
}

/**
 * Community-level: all board members.
 * Property-scoped: all board members + all property owners.
 */
async function resolvePropertyScopedRecipients({
  hoaId,
  propertyId,
  actorUserId = null,
  extraOwnerIds = [],
} = {}) {
  const resolvedHoaId = toIdString(hoaId) || (propertyId ? await resolveHoaIdFromProperty(propertyId) : '');
  if (!resolvedHoaId) return [];

  const boardIds = await resolveBoardMemberIds(resolvedHoaId);
  if (!propertyId && (!extraOwnerIds || extraOwnerIds.length === 0)) {
    return excludeVendorUserIds(boardIds);
  }

  let ownerIds = propertyId ? await resolvePropertyOwnerUserIds(propertyId) : [];
  if (Array.isArray(extraOwnerIds) && extraOwnerIds.length) {
    ownerIds = dedupeIds([...ownerIds, ...extraOwnerIds]);
  }

  return excludeVendorUserIds(mergeBoardAndAffected(boardIds, ownerIds, actorUserId));
}

/**
 * Property created/updated/deleted:
 * All board members + all property owners (no owners on unit → board only).
 */
async function resolvePropertyNotificationRecipients({
  hoaId,
  propertyId,
  actorUserId = null,
  ownerIds = null,
} = {}) {
  return resolvePropertyScopedRecipients({
    hoaId,
    propertyId,
    actorUserId,
    extraOwnerIds: Array.isArray(ownerIds) ? ownerIds : [],
  });
}

/**
 * Owner CRUD (community-level, not property-scoped):
 * All board members + the affected owner (including when the owner is the actor).
 */
async function resolveOwnerNotificationRecipients({
  hoaId,
  ownerUserId = null,
  actorUserId = null,
} = {}) {
  const resolvedHoaId = toIdString(hoaId);
  if (!resolvedHoaId) return [];

  const boardIds = await resolveBoardMemberIds(resolvedHoaId);
  const ownerId = toIdString(ownerUserId);
  if (ownerId) {
    return excludeVendorUserIds(mergeBoardAndAffected(boardIds, [ownerId], actorUserId));
  }

  return excludeVendorUserIds(boardIds);
}

/**
 * Invoice lifecycle: all board + payers/tenants + property owners.
 */
async function resolveInvoiceLifecycleRecipients(invoice, actorUserId = null) {
  const hoaId = toIdString(invoice?.hoaId);
  if (!hoaId) return [];

  const boardIds = await resolveBoardMemberIds(hoaId);
  const affected = [];

  const payers = await resolveInvoicePayerUsers(invoice);
  for (const payer of payers) {
    affected.push(toIdString(payer._id || payer));
  }

  for (const tenant of invoice?.tenants || []) {
    affected.push(toIdString(tenant && tenant._id ? tenant._id : tenant));
  }

  const propertyId = toIdString(invoice?.propertyId);
  if (propertyId) {
    affected.push(...(await resolvePropertyOwnerUserIds(propertyId)));
  }

  return excludeVendorUserIds(mergeBoardAndAffected(boardIds, affected, actorUserId));
}

/**
 * Payment recorded/deleted: all board + property owners (or payers when no property).
 */
async function resolveInvoicePaymentRecipients(invoice, actorUserId = null) {
  const hoaId = toIdString(invoice?.hoaId);
  if (!hoaId) return [];

  const boardIds = await resolveBoardMemberIds(hoaId);
  const propertyId = toIdString(invoice?.propertyId);
  let affected = [];

  if (propertyId) {
    affected = await resolvePropertyOwnerUserIds(propertyId);
  } else {
    affected = (await resolveInvoicePayerUsers(invoice)).map((p) => toIdString(p._id || p));
    for (const tenant of invoice?.tenants || []) {
      affected.push(toIdString(tenant && tenant._id ? tenant._id : tenant));
    }
  }

  return excludeVendorUserIds(mergeBoardAndAffected(boardIds, affected, actorUserId));
}

/**
 * Expense lifecycle:
 * With property → all board + all property owners.
 * Community expense (no property) → all board members.
 *
 * Vendors are intentionally excluded: expenses are HOA accounting events.
 * Vendors are notified via vendor-invoice payment flows instead.
 */
async function resolveExpenseNotificationRecipients(expense, actorUserId = null) {
  let hoaId = resolveExpenseHoaId(expense);
  const propertyId = resolveExpensePropertyId(expense);

  if (!hoaId && propertyId) {
    hoaId = await resolveHoaIdFromProperty(propertyId);
  }
  if (!hoaId) return [];

  return resolvePropertyScopedRecipients({ hoaId, propertyId, actorUserId });
}

async function resolvePropertyForMaintenance(doc) {
  const rawId = doc?.property_id && (doc.property_id._id || doc.property_id);
  const propertyId = toObjectId(rawId);
  if (!propertyId) return null;
  const fields = 'hoaId landlord_id associatedOwnerIds name unitDetails';
  // Prefer landlord Property model (same collection; matches create/assign email helper).
  try {
    const LandlordProperty = require('../../portals/landlord/modules/property/model/property.model');
    const property = await LandlordProperty.findById(propertyId).select(fields).lean();
    if (property) return property;
  } catch {
    /* fall through to HOA model */
  }
  try {
    const HOAProperty = require('../../portals/hoa-board/modules/property/model/property.model');
    return HOAProperty.findOne({ _id: { $eq: propertyId }, isDeleted: { $ne: true } })
      .select(fields)
      .lean();
  } catch {
    return null;
  }
}

async function resolveHoaIdForMaintenance(doc, property = null) {
  if (doc?.hoaId) return toIdString(doc.hoaId);
  if (property?.hoaId) return toIdString(property.hoaId);
  if (!property) {
    const loaded = await resolvePropertyForMaintenance(doc);
    if (loaded?.hoaId) return toIdString(loaded.hoaId);
  }
  return '';
}

/**
 * Assignee + requestedBy user ids from a maintenance ticket (populated or raw ObjectIds).
 */
function collectMaintenanceAffectedUserIds(doc = {}) {
  const affected = [];
  const requestedBy = doc?.requestedBy;
  if (Array.isArray(requestedBy)) {
    for (const rb of requestedBy) {
      affected.push(toIdString(rb && rb._id ? rb._id : rb));
    }
  } else if (requestedBy) {
    affected.push(toIdString(requestedBy._id || requestedBy));
  }

  const assigneeId = toIdString(
    doc?.assignedTo && doc.assignedTo._id ? doc.assignedTo._id : doc?.assignedTo
  );
  if (assigneeId) affected.push(assigneeId);
  return dedupeIds(affected);
}

function maintenanceAssigneeId(doc = {}) {
  return toIdString(doc?.assignedTo && doc.assignedTo._id ? doc.assignedTo._id : doc?.assignedTo);
}

/**
 * Maintenance: all board + all property owners + assignee + requestedBy users.
 * Assigned vendor is always included. When the vendor is the actor, they are
 * excluded so board/owners receive the update instead of a self-notification,
 * unless options.includeVendorActor is true (e.g. for maintenance comments where
 * the acting vendor must receive an in-app notification).
 * Notify Requester (notifyTenant) gates whether requestedBy users are included
 * (aligned with email behavior for owner ↔ board workflows).
 */
async function resolveMaintenanceNotificationRecipients(doc, actorUserId = null, options = {}) {
  const property = await resolvePropertyForMaintenance(doc);
  const hoaId = await resolveHoaIdForMaintenance(doc, property);
  const affected = collectMaintenanceAffectedUserIds(doc);
  const assigneeId = maintenanceAssigneeId(doc);
  const actor = toIdString(actorUserId);

  let recipients;
  if (!hoaId) {
    if (property?.landlord_id) {
      affected.push(toIdString(property.landlord_id));
    }
    recipients = excludeActor(affected, actorUserId);
    if (options.includeVendorActor && actor && assigneeId && actor === assigneeId) {
      recipients = dedupeIds([...recipients, actor]);
    }
  } else {
    const boardIds = await resolveBoardMemberIds(hoaId);
    if (property) {
      affected.push(...(await resolvePropertyOwnerUserIds(property._id)));
    }
    recipients = mergeBoardAndAffected(boardIds, affected, actorUserId);
    if (actor && assigneeId && actor === assigneeId && !options.includeVendorActor) {
      recipients = excludeActor(recipients, actorUserId);
    }
  }

  // Keep Notify Requester semantics consistent across in-app and email.
  const { filterMaintenanceNotifyUserIds } = require('./maintenanceEmailRecipients');
  return filterMaintenanceNotifyUserIds(doc, recipients);
}

/**
 * Vendor invoices: board members + assignee + vendor (actor excluded).
 * Resolves hoaId from the linked maintenance ticket when the invoice has none.
 */
async function resolveVendorInvoiceNotificationRecipients(invoice, actorUserId = null) {
  let hoaId = toIdString(invoice?.hoaId);
  if (!hoaId && invoice?.maintenanceRequestId) {
    try {
      const MaintenanceRequest = require('../../shared/modules/maintenance/model/maintenanceRequest.model');
      const ticket = await MaintenanceRequest.findOne({
        _id: invoice.maintenanceRequestId,
        isDeleted: { $ne: true },
      })
        .select('hoaId')
        .lean();
      hoaId = toIdString(ticket?.hoaId);
    } catch {
      hoaId = '';
    }
  }
  const boardIds = hoaId ? await resolveBoardMemberIds(hoaId) : [];
  const affected = [
    toIdString(invoice?.assignedTo && invoice.assignedTo._id ? invoice.assignedTo._id : invoice?.assignedTo),
    toIdString(invoice?.vendorId && invoice.vendorId._id ? invoice.vendorId._id : invoice?.vendorId),
  ];
  return excludeActor(mergeBoardAndAffected(boardIds, affected), actorUserId);
}

/**
 * Vendor CRUD / assign (community-level): all board members (vendors excluded).
 */
async function resolveVendorNotificationRecipients({ hoaId, actorUserId = null } = {}) {
  const resolvedHoaId = toIdString(hoaId);
  if (!resolvedHoaId) return [];
  return excludeVendorUserIds(await resolveBoardMemberIds(resolvedHoaId, actorUserId));
}

function explicitDocumentOwnerIds(document = {}) {
  const ids = (document.allowedOwnerIds || []).map(toIdString);
  if (document.linkedOwnerId) ids.push(toIdString(document.linkedOwnerId));
  return dedupeIds(ids);
}

function explicitDocumentBoardIds(document = {}) {
  return dedupeIds((document.allowedBoardMemberIds || []).map(toIdString));
}

/**
 * Document upload notifications follow the same audience as library visibility.
 * Owners Only reaches granted owners (and the board only when explicitly shared).
 * All Residents reaches the community. Board Only reaches board members.
 */
async function resolveDocumentNotificationRecipients(document, actorUserId = null) {
  const hoaId = document?.hoaId ? toIdString(document.hoaId) : '';
  if (!hoaId) return [];

  const {
    ACCESS_LEVELS,
    isSelectiveBoardOwner,
    normalizeAccessLevel,
  } = require('../../shared/modules/documents/helpers/hoaDocumentAccess');

  const accessLevel = normalizeAccessLevel(document?.accessLevel);
  const ownerIds = explicitDocumentOwnerIds(document);
  const boardGrantIds = explicitDocumentBoardIds(document);

  if (isSelectiveBoardOwner(accessLevel)) {
    return excludeVendorUserIds(mergeBoardAndAffected(boardGrantIds, ownerIds, actorUserId));
  }

  if (accessLevel === ACCESS_LEVELS.BOARD_ONLY) {
    return excludeVendorUserIds(await resolveBoardMemberIds(hoaId, actorUserId));
  }

  if (accessLevel === ACCESS_LEVELS.OWNERS_ONLY) {
    const boardIds = document.allowCommunityBoardAccess === true
      ? await resolveBoardMemberIds(hoaId)
      : boardGrantIds;
    return excludeVendorUserIds(mergeBoardAndAffected(boardIds, ownerIds, actorUserId));
  }

  const boardIds = await resolveBoardMemberIds(hoaId);
  const affected = [...ownerIds];

  const Property = require('../../portals/hoa-board/modules/property/model/property.model');
  const safeHoaId = toObjectId(hoaId);
  if (safeHoaId) {
    try {
      const properties = await Property.find({
        hoaId: safeHoaId,
        isDeleted: { $ne: true },
      })
        .select('associatedOwnerIds')
        .lean();
      for (const prop of properties) {
        for (const ownerId of prop.associatedOwnerIds || []) {
          affected.push(toIdString(ownerId));
        }
        affected.push(...(await resolvePropertyOwnerUserIds(prop._id)));
      }
    } catch {
      // fall through with explicit owner ids only
    }
  }

  return excludeVendorUserIds(mergeBoardAndAffected(boardIds, affected, actorUserId));
}

module.exports = {
  toIdString,
  dedupeIds,
  excludeActor,
  excludeVendorUserIds,
  resolveBoardMemberIds,
  resolvePropertyOwnerUserIds,
  resolvePropertyScopedRecipients,
  resolvePropertyNotificationRecipients,
  resolveOwnerNotificationRecipients,
  resolveInvoiceLifecycleRecipients,
  resolveInvoicePaymentRecipients,
  resolveExpenseNotificationRecipients,
  collectMaintenanceAffectedUserIds,
  maintenanceAssigneeId,
  resolveMaintenanceNotificationRecipients,
  resolveVendorInvoiceNotificationRecipients,
  resolveVendorNotificationRecipients,
  resolveDocumentNotificationRecipients,
  resolveHoaIdFromProperty,
  resolveExpensePropertyId,
  resolvePropertyForMaintenance,
  resolveHoaIdForMaintenance,
  mergeBoardAndAffected,
};
