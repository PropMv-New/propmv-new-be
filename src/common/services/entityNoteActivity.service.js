/**
 * ------------------------------------------------------------------
 * File: entityNoteActivity.service.js
 * Module: Src Common Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * noteReminder.service, invoice.service, owner.service, property.service
 * ------------------------------------------------------------------
 */

const { logActivity } = require('../../portals/hoa-board/modules/dashboard/service/activity.service');

/**
 * Map note-level actions to Activity.action enum values:
 * CREATE | UPDATE | DELETE | PAYMENT_SUCCESS | PAYMENT_FAILED | STATUS_CHANGE | ARCHIVE | RESTORE | UPLOAD | DOWNLOAD
 */
const NOTE_ACTION_TO_ACTIVITY = {
  created: 'CREATE',
  updated: 'UPDATE',
  deleted: 'DELETE',
  pinned: 'UPDATE',
  unpinned: 'UPDATE',
  important: 'UPDATE',
  unimportant: 'UPDATE',
  reminder_set: 'UPDATE',
  reminder_updated: 'UPDATE',
  reminder_cleared: 'UPDATE',
  reminder_completed: 'UPDATE',
};

function resolveActivityAction(noteAction) {
  const key = String(noteAction || '').trim().toLowerCase();
  if (NOTE_ACTION_TO_ACTIVITY[key]) return NOTE_ACTION_TO_ACTIVITY[key];

  // Accept already-valid Activity enum values (case-insensitive)
  const upper = key.toUpperCase();
  const allowed = new Set([
    'CREATE', 'UPDATE', 'DELETE', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED',
    'STATUS_CHANGE', 'ARCHIVE', 'RESTORE', 'UPLOAD', 'DOWNLOAD',
  ]);
  if (allowed.has(upper)) return upper;

  // Legacy aliases
  if (upper === 'CREATED') return 'CREATE';
  if (upper === 'DELETED') return 'DELETE';
  if (upper === 'UPDATED' || upper === 'EDITED') return 'UPDATE';

  return 'UPDATE';
}

async function logEntityNoteActivity({
  userId,
  module,
  entityId,
  entityName,
  action,
  noteTitle,
  notePreview,
  meta = {},
}) {
  const label = noteTitle?.trim() || (notePreview ? String(notePreview).slice(0, 80) : 'Note');
  const descriptions = {
    created: `Note created: ${label}`,
    updated: `Note edited: ${label}`,
    deleted: `Note deleted: ${label}`,
    pinned: `Note pinned: ${label}`,
    unpinned: `Note unpinned: ${label}`,
    important: `Note marked important: ${label}`,
    unimportant: `Note unmarked important: ${label}`,
    reminder_set: `Reminder set on note: ${label}`,
    reminder_updated: `Reminder updated on note: ${label}`,
    reminder_cleared: `Reminder cleared on note: ${label}`,
    reminder_completed: `Reminder completed for note: ${label}`,
  };

  const noteActionKey = String(action || '').trim().toLowerCase();

  await logActivity({
    userId,
    action: resolveActivityAction(action),
    module: module || 'Other',
    entityId,
    entityName: entityName || module || 'Entity',
    description: descriptions[noteActionKey] || `Note ${noteActionKey || 'updated'}: ${label}`,
    meta: { noteTitle, noteAction: noteActionKey || action, ...meta },
  });
}

module.exports = { logEntityNoteActivity, resolveActivityAction };
