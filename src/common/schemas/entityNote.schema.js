/**
 * ------------------------------------------------------------------
 * File: entityNote.schema.js
 * Module: Src Common Schemas
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * invoice.model
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Shared embedded note shape for HOA board entities (invoice comments, property notes, owner notes).
 */
const EntityNoteSchema = new Schema({
  /** Body / description */
  text: { type: String, required: true, trim: true, maxlength: 5000 },
  title: { type: String, default: '', trim: true, maxlength: 200 },
  isPinned: { type: Boolean, default: false },
  isImportant: { type: Boolean, default: false },
  reminder: { type: Date },
  reminderNotifiedAt: { type: Date },
  /** System audit entries (e.g. payment reminder sent) - excluded from user note counts */
  isSystem: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  attachments: [{ type: Schema.Types.ObjectId, ref: 'DocumentMetadata' }],
}, { _id: true });

/**
 * Resolve the first valid ObjectId from candidate user ids (invoice.createdBy, tenants, actor, etc.).
 */
function resolveEntityNoteCreatorId(...candidates) {
  for (const id of candidates) {
    const raw = id?._id ?? id;
    if (raw && mongoose.Types.ObjectId.isValid(String(raw))) {
      return new mongoose.Types.ObjectId(String(raw));
    }
  }
  return null;
}

/**
 * Backfill required EntityNote fields on embedded comments before a full document save.
 * Handles legacy rows created before `createdBy` was required (e.g. system late-fee notes).
 */
function ensureEntityNotesHaveCreator(comments, fallbackUserId) {
  if (!Array.isArray(comments)) return;
  const fallback = resolveEntityNoteCreatorId(fallbackUserId);
  if (!fallback) return;
  const now = new Date();
  for (const comment of comments) {
    if (!comment || typeof comment !== 'object') continue;
    if (!resolveEntityNoteCreatorId(comment.createdBy)) {
      comment.createdBy = fallback;
    }
    if (!resolveEntityNoteCreatorId(comment.updatedBy)) {
      comment.updatedBy = comment.createdBy;
    }
    if (!comment.createdAt) comment.createdAt = now;
    if (!comment.updatedAt) comment.updatedAt = now;
  }
}

module.exports = { EntityNoteSchema, resolveEntityNoteCreatorId, ensureEntityNotesHaveCreator };
