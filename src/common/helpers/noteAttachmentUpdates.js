const documentsService = require('../../shared/modules/documents/service/documents.service');
const logger = require('../logger');

function parseRemoveAttachmentIds(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return trimmed.split(',').map((part) => part.trim()).filter(Boolean);
    }
  }
  return [];
}

function getAttachmentId(att) {
  if (!att) return null;
  if (typeof att === 'string') return att;
  return String(att._id || att.id || att);
}

/**
 * Remove attachment refs from a note and delete backing document metadata/storage.
 * Returns the list of removed metadata IDs.
 */
async function removeAttachmentsFromNote(note, removeAttachmentIds = []) {
  const removeSet = new Set(parseRemoveAttachmentIds(removeAttachmentIds));
  if (removeSet.size === 0) return [];

  const current = Array.isArray(note.attachments) ? note.attachments : [];
  const removedIds = [];
  const kept = [];

  for (const att of current) {
    const id = getAttachmentId(att);
    if (id && removeSet.has(id)) {
      removedIds.push(id);
    } else {
      kept.push(att);
    }
  }

  note.attachments = kept;

  for (const metaId of removedIds) {
    try {
      await documentsService.deleteDocument(metaId);
    } catch (err) {
      logger.warn(`Failed to delete note attachment ${metaId}:`, err.message);
    }
  }

  return removedIds;
}

module.exports = {
  parseRemoveAttachmentIds,
  getAttachmentId,
  removeAttachmentsFromNote,
};
