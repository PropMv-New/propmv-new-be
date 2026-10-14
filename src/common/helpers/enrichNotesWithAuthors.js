/**
 * ------------------------------------------------------------------
 * File: enrichNotesWithAuthors.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for enrichNotesWithAuthors.
 *
 * Used By:
 * owner.service, property.service
 * ------------------------------------------------------------------
 */

const User = require('../../shared/modules/users/models/user.model');

/**
 * creator Id From Note
 *
 * Performs logic operations for creatorIdFromNote.
 *
 * @param note - Request/input argument
 * @returns Operations result
 */
function creatorIdFromNote(note) {
  const cb = note?.createdBy;
  if (!cb) return null;
  if (typeof cb === 'string' && /^[0-9a-fA-F]{24}$/.test(cb.trim())) return cb.trim();
  if (typeof cb === 'object' && cb._id) return String(cb._id);
  return null;
}

/**
 * Replace note.createdBy ObjectIds with { firstName, lastName, email } for API responses.
 */
async function enrichNotesWithAuthors(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return notes || [];

  const ids = [...new Set(notes.map(creatorIdFromNote).filter(Boolean))];
  if (!ids.length) {
    return notes.map((note) => (
      note && typeof note.toObject === 'function' ? note.toObject() : { ...note }
    ));
  }

  const users = await User.find({ _id: { $in: ids }, isDeleted: { $ne: true } })
    .select('firstName lastName email')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  return notes.map((note) => {
    const plain = note && typeof note.toObject === 'function' ? note.toObject() : { ...note };
    const id = creatorIdFromNote(plain);
    if (id && byId.has(id)) {
      return { ...plain, createdBy: byId.get(id) };
    }
    return plain;
  });
}

module.exports = { enrichNotesWithAuthors };
