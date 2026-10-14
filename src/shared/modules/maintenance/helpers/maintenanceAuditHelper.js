/**
 * ------------------------------------------------------------------
 * File: maintenanceAuditHelper.js
 * Module: Maintenance Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceAuditHelper.
 *
 * Used By:
 * maintenance.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const User = require('../../users/models/user.model');
const { resolveUserRoleName } = require('../../../../common/helpers/companyRoleHelper');
const { applySession } = require('../service/maintenanceDb.util');

/**
 * format Person With Role
 *
 * Performs logic operations for formatPersonWithRole.
 *
 * @param firstName - Request/input argument
 * @param lastName - Request/input argument
 * @param roleName - Request/input argument
 * @returns Operations result
 */
function formatPersonWithRole(firstName, lastName, roleName) {
  const name = `${firstName || ''} ${lastName || ''}`.trim() || 'Unknown';
  const role = String(roleName || '').trim();
  return role ? `${name} (${role})` : name;
}

/**
 * normalize Requested By Ids
 *
 * Performs logic operations for normalizeRequestedByIds.
 *
 * @param requestedBy - Request/input argument
 * @returns Operations result
 */
function normalizeRequestedByIds(requestedBy) {
  if (!requestedBy) return [];
  const values = Array.isArray(requestedBy) ? requestedBy : [requestedBy];
  const ids = [];
  for (const entry of values) {
    const raw = entry && typeof entry === 'object' && entry._id ? entry._id : entry;
    const str = String(raw || '').trim();
    if (!str || !mongoose.Types.ObjectId.isValid(str)) continue;
    if (!ids.some((id) => String(id) === str)) ids.push(str);
  }
  return ids;
}

/**
 * extract Creator Id
 *
 * Performs logic operations for extractCreatorId.
 *
 * @param doc - Request/input argument
 * @returns Operations result
 */
function extractCreatorId(doc) {
  if (!doc?.createdBy) return null;
  const raw = typeof doc.createdBy === 'object' && doc.createdBy._id ? doc.createdBy._id : doc.createdBy;
  const str = String(raw || '').trim();
  return mongoose.Types.ObjectId.isValid(str) ? str : null;
}

/**
 * is Self Created Maintenance
 *
 * Performs logic operations for isSelfCreatedMaintenance.
 *
 * @param doc - Request/input argument
 * @returns Operations result
 */
function isSelfCreatedMaintenance(doc) {
  const creatorId = extractCreatorId(doc);
  if (!creatorId) return false;
  return normalizeRequestedByIds(doc.requestedBy).includes(creatorId);
}

/**
 * build Maintenance Created Activity Summary
 *
 * Performs logic operations for buildMaintenanceCreatedActivitySummary.
 *
 * @returns Operations result
 */
function buildMaintenanceCreatedActivitySummary({
  createdByDisplay,
  requestedForDisplay,
  isSelfCreated,
}) {
  if (!createdByDisplay) return null;
  if (isSelfCreated) {
    return `Maintenance request created by ${createdByDisplay}.`;
  }
  if (requestedForDisplay) {
    return `Maintenance request created by ${createdByDisplay} on behalf of ${requestedForDisplay}.`;
  }
  return `Maintenance request created by ${createdByDisplay}.`;
}

/**
 * Persist audit snapshot fields at creation time.
 */
async function attachMaintenanceAuditSnapshot(data, { session } = {}) {
  if (!data) return data;

  const actorUserId = extractCreatorId(data);
  const requestedByIds = normalizeRequestedByIds(data.requestedBy);

  let createdByName = null;
  let createdByRole = null;

  if (actorUserId) {
    const creator = await applySession(
      User.findById(actorUserId).select('firstName lastName companyRoleId role companyId'),
      session
    ).lean();
    if (creator) {
      createdByRole = await resolveUserRoleName(creator);
      createdByName = `${creator.firstName || ''} ${creator.lastName || ''}`.trim() || null;
    }
  }

  let requestedForLabel = null;
  let requestedForType = null;

  if (requestedByIds.length > 0) {
    const requesters = await applySession(
      User.find({ _id: { $in: requestedByIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select('firstName lastName companyRoleId role companyId'),
      session
    ).lean();

    const byId = new Map(requesters.map((user) => [String(user._id), user]));
    const labels = [];
    for (const id of requestedByIds) {
      const user = byId.get(String(id));
      if (!user) continue;
      const role = await resolveUserRoleName(user);
      labels.push(formatPersonWithRole(user.firstName, user.lastName, role));
    }
    if (labels.length > 0) {
      requestedForLabel = labels.join(', ');
      requestedForType = 'user';
    }
  }

  if (!requestedForLabel) {
    const unitLabel = String(data.units || data.unitName || '').trim();
    if (unitLabel) {
      requestedForLabel = unitLabel;
      requestedForType = 'unit';
    }
  }

  data.createdByName = createdByName;
  data.createdByRole = createdByRole;
  data.requestedForLabel = requestedForLabel;
  data.requestedForType = requestedForType;

  return data;
}

function personDisplayFromUser(user) {
  if (!user) return 'Unknown';
  if (typeof user === 'string') return user;
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || user.email || 'Unknown';
}

/**
 * Resolve actor id + display name (with role when available) for activityLog entries.
 */
async function resolveMaintenanceActivityActor(userId, { session } = {}) {
  const raw = userId && typeof userId === 'object' && userId._id ? userId._id : userId;
  const idStr = String(raw || '').trim();
  if (!idStr || !mongoose.Types.ObjectId.isValid(idStr)) {
    return { performedBy: null, performedByName: 'Unknown' };
  }

  const user = await applySession(
    User.findById(idStr).select('firstName lastName email companyRoleId role companyId'),
    session
  ).lean();

  if (!user) {
    return { performedBy: idStr, performedByName: 'Unknown' };
  }

  const roleName = await resolveUserRoleName(user);
  return {
    performedBy: idStr,
    performedByName: formatPersonWithRole(user.firstName, user.lastName, roleName),
  };
}

function buildMaintenanceActivityEntry({
  type,
  description,
  performedBy = null,
  performedByName = null,
  createdAt = null,
  meta = null,
}) {
  const entry = {
    type: String(type || 'edited'),
    description: String(description || '').trim(),
    performedBy: performedBy || null,
    performedByName: performedByName || null,
    createdAt: createdAt ? new Date(createdAt) : new Date(),
  };
  if (meta && typeof meta === 'object') {
    entry.meta = meta;
  }
  return entry;
}

function parseMaintenanceActionComment(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('Action:')) return null;

  const resolvedMatch = raw.match(/^Action:\s*Marked as resolved\.?(?:\s*Comment:\s*(.*))?$/i);
  if (resolvedMatch) {
    const comment = String(resolvedMatch[1] || '').trim();
    return {
      action: 'resolved',
      description: comment
        ? `Marked as resolved. Comment: ${comment}`
        : 'Marked as resolved.',
    };
  }

  const reopenedMatch = raw.match(/^Action:\s*Reopened request\.?(?:\s*Comment:\s*(.*))?$/i);
  if (reopenedMatch) {
    const comment = String(reopenedMatch[1] || '').trim();
    return {
      action: 'reopened',
      description: comment
        ? `Ticket reopened. Comment: ${comment}`
        : 'Ticket reopened.',
    };
  }

  return null;
}

function activitySortTime(entry) {
  const t = entry?.createdAt ? new Date(entry.createdAt).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function hasLoggedStatusAction(activityLog, action) {
  return (activityLog || []).some(
    (entry) => entry?.type === 'status' && entry?.meta?.action === action
  );
}

/**
 * Build Activity Timeline entries for API/UI (creation + activityLog + legacy notes/actions).
 */
function buildMaintenanceActivityTimeline(doc, {
  creationActivitySummary = null,
  createdByDisplay = null,
} = {}) {
  if (!doc || typeof doc !== 'object') return [];

  const activityLog = Array.isArray(doc.activityLog) ? doc.activityLog : [];
  const entries = [];

  const createdAt = doc.createdAt || doc.request_date || null;
  const createdSummary = creationActivitySummary
    || (createdByDisplay ? `Maintenance request created by ${createdByDisplay}.` : 'Maintenance request created.');
  entries.push({
    id: 'created',
    type: 'created',
    description: createdSummary,
    performedByName: createdByDisplay || null,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    meta: { source: 'created' },
  });

  const loggedNoteIds = new Set(
    activityLog
      .filter((entry) => entry?.meta?.noteId)
      .map((entry) => String(entry.meta.noteId))
  );

  for (const entry of activityLog) {
    if (!entry || !entry.description) continue;
    entries.push({
      id: entry._id ? String(entry._id) : `log-${activitySortTime(entry)}-${entry.type}`,
      type: entry.type || 'edited',
      description: entry.description,
      performedByName: entry.performedByName || null,
      createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
      meta: entry.meta || null,
    });
  }

  const notes = Array.isArray(doc.notes) ? doc.notes : [];
  for (const note of notes) {
    const noteId = note?._id ? String(note._id) : null;
    if (noteId && loggedNoteIds.has(noteId)) continue;

    const authorName = personDisplayFromUser(note?.author);
    const content = String(note?.content || '').trim();
    const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content;
    entries.push({
      id: noteId || `note-${activitySortTime(note)}`,
      type: 'note',
      description: preview
        ? `Note added by ${authorName}: "${preview}"`
        : `Note added by ${authorName}.`,
      performedByName: authorName,
      createdAt: note?.createdAt ? new Date(note.createdAt).toISOString() : null,
      meta: { source: 'notes', noteId, action: 'note_added' },
    });
  }

  const comments = Array.isArray(doc.comments) ? doc.comments : [];
  for (const comment of comments) {
    const parsed = parseMaintenanceActionComment(comment?.text);
    if (!parsed) continue;
    if (hasLoggedStatusAction(activityLog, parsed.action)) continue;

    const authorName = personDisplayFromUser(comment?.author);
    entries.push({
      id: comment?._id ? String(comment._id) : `status-${parsed.action}-${activitySortTime(comment)}`,
      type: 'status',
      description: `${parsed.description}${authorName && authorName !== 'Unknown' ? ` By ${authorName}.` : ''}`,
      performedByName: authorName,
      createdAt: comment?.createdAt ? new Date(comment.createdAt).toISOString() : null,
      meta: { source: 'comments', action: parsed.action },
    });
  }

  return entries.sort((a, b) => activitySortTime(a) - activitySortTime(b));
}

const MAINTENANCE_EDIT_ACTIVITY_FIELDS = [
  'title',
  'description',
  'category',
  'priority',
  'isUrgent',
  'primaryRequestType',
  'subRequestType',
  'units',
  'unitId',
  'property_id',
  'requestedBy',
  'notifyTenant',
  'requestToDelete',
  'deletedDocuments',
];

function updatesIncludeMaintenanceEditFields(updates = {}) {
  return MAINTENANCE_EDIT_ACTIVITY_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(updates, key));
}

function isMaintenanceReopenUpdate(previousStatus, nextStatus) {
  return String(previousStatus || '').toLowerCase() === 'resolved'
    && String(nextStatus || '').toLowerCase() === 'open';
}

/**
 * Add display-friendly audit fields for API responses (supports legacy tickets).
 */
function enrichMaintenanceAuditDisplay(doc) {
  if (!doc || typeof doc !== 'object') return doc;

  const createdByUser = doc.createdBy && typeof doc.createdBy === 'object' ? doc.createdBy : null;
  const createdByName = doc.createdByName
    || (createdByUser ? `${createdByUser.firstName || ''} ${createdByUser.lastName || ''}`.trim() : null)
    || null;
  const createdByRole = doc.createdByRole || null;
  const createdByDisplay = createdByName
    ? (createdByRole ? `${createdByName} (${createdByRole})` : createdByName)
    : null;

  let requestedForDisplay = doc.requestedForLabel || null;
  let requestedForType = doc.requestedForType || null;
  if (!requestedForDisplay) {
    const requesters = Array.isArray(doc.requestedBy)
      ? doc.requestedBy
      : doc.requestedBy
        ? [doc.requestedBy]
        : [];
    const names = requesters
      .map((user) => `${user?.firstName || ''} ${user?.lastName || ''}`.trim())
      .filter(Boolean);
    if (names.length > 0) {
      requestedForDisplay = names.join(', ');
      requestedForType = requestedForType || 'user';
    } else if (doc.unitName || doc.units) {
      requestedForDisplay = doc.unitName || doc.units;
      requestedForType = requestedForType || 'unit';
    }
  }

  const selfCreated = isSelfCreatedMaintenance(doc);
  const creationActivitySummary = buildMaintenanceCreatedActivitySummary({
    createdByDisplay,
    requestedForDisplay,
    isSelfCreated: selfCreated,
  });

  const enriched = {
    ...doc,
    createdByName,
    createdByRole,
    createdByDisplay,
    requestedForDisplay,
    requestedForLabel: doc.requestedForLabel || requestedForDisplay,
    requestedForType,
    isSelfCreated: selfCreated,
    creationActivitySummary,
  };

  enriched.activityTimeline = buildMaintenanceActivityTimeline(enriched, {
    creationActivitySummary,
    createdByDisplay,
  });

  return enriched;
}

module.exports = {
  attachMaintenanceAuditSnapshot,
  enrichMaintenanceAuditDisplay,
  buildMaintenanceCreatedActivitySummary,
  buildMaintenanceActivityTimeline,
  buildMaintenanceActivityEntry,
  resolveMaintenanceActivityActor,
  parseMaintenanceActionComment,
  updatesIncludeMaintenanceEditFields,
  isMaintenanceReopenUpdate,
  formatPersonWithRole,
  isSelfCreatedMaintenance,
};
