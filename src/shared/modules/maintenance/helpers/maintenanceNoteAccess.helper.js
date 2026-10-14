'use strict';

const { normalizeUserId } = require('../../../../common/helpers/maintenanceEmailRecipients');

function normalizeMaintenanceNoteAuthorId(note) {
  if (!note) return null;
  return normalizeUserId(note.author);
}

function isPrivateMaintenanceNotesScope(userContext = null) {
  if (!userContext || typeof userContext !== 'object') return false;
  return Boolean(
    userContext.hoaId
    || userContext.isHOABoardMember
    || userContext.isHOAOwner
    || userContext.isVendor
    || userContext.role === 'vendor'
    || userContext.role === 'hoa_board_member'
    || userContext.role === 'hoa_owner'
  );
}

function filterMaintenanceNotesForViewer(notes, viewerUserId) {
  if (!viewerUserId) return [];
  const viewerId = String(viewerUserId);
  return (Array.isArray(notes) ? notes : []).filter((note) => {
    const authorId = normalizeMaintenanceNoteAuthorId(note);
    return authorId && authorId === viewerId;
  });
}

function assertMaintenanceNoteOwner(note, viewerUserId) {
  const authorId = normalizeMaintenanceNoteAuthorId(note);
  const viewerId = viewerUserId ? String(viewerUserId) : '';
  if (!note) {
    const err = new Error('Note not found');
    err.status = 404;
    throw err;
  }
  if (!viewerId || !authorId || authorId !== viewerId) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }
}

function findMaintenanceNoteById(request, noteId) {
  if (!request || !noteId) return null;
  const targetId = String(noteId);
  const notes = Array.isArray(request.notes) ? request.notes : [];
  return notes.find((note) => note && String(note._id || note.id) === targetId) || null;
}

function filterMaintenanceActivityTimelineForViewer(timeline, viewerUserId, { privateNotes = false, notes = [] } = {}) {
  if (!privateNotes || !viewerUserId) return timeline;
  const viewerId = String(viewerUserId);
  const ownedNoteIds = new Set(
    filterMaintenanceNotesForViewer(notes, viewerUserId).map((note) => String(note._id || note.id))
  );

  return (Array.isArray(timeline) ? timeline : []).filter((entry) => {
    if (!entry) return false;
    const type = String(entry.type || '').toLowerCase();
    if (type !== 'note') return true;

    const noteId = entry.meta?.noteId ? String(entry.meta.noteId) : null;
    if (noteId && ownedNoteIds.has(noteId)) return true;
    if (noteId && !ownedNoteIds.has(noteId)) return false;

    const source = entry.meta?.source;
    if (source === 'notes') {
      return ownedNoteIds.has(String(entry.id || ''));
    }

    return false;
  });
}

function filterMaintenanceActivityLogForViewer(activityLog, viewerUserId, { privateNotes = false } = {}) {
  if (!privateNotes || !viewerUserId) return activityLog;
  const viewerId = String(viewerUserId);

  return (Array.isArray(activityLog) ? activityLog : []).filter((entry) => {
    if (!entry) return false;
    if (String(entry.type || '').toLowerCase() !== 'note') return true;
    const performedBy = normalizeUserId(entry.performedBy);
    return performedBy && performedBy === viewerId;
  });
}

function applyPrivateMaintenanceNotesForViewer(doc, viewerUserId, userContext = null) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!isPrivateMaintenanceNotesScope(userContext)) return doc;

  const filteredNotes = filterMaintenanceNotesForViewer(doc.notes, viewerUserId);
  const filteredActivityLog = filterMaintenanceActivityLogForViewer(doc.activityLog, viewerUserId, {
    privateNotes: true,
  });

  return {
    ...doc,
    notes: filteredNotes,
    activityLog: filteredActivityLog,
  };
}

module.exports = {
  normalizeMaintenanceNoteAuthorId,
  isPrivateMaintenanceNotesScope,
  filterMaintenanceNotesForViewer,
  assertMaintenanceNoteOwner,
  findMaintenanceNoteById,
  filterMaintenanceActivityTimelineForViewer,
  filterMaintenanceActivityLogForViewer,
  applyPrivateMaintenanceNotesForViewer,
};
