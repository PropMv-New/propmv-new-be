const path = require('path');
const DocumentMetadata = require('../../shared/modules/documents/model/documentMetadata.model');
const documentsService = require('../../shared/modules/documents/service/documents.service');
const { isLegacyLocalNoteAttachment } = require('./uploadNoteAttachments');

/**
 * Resolve note attachment ObjectIds to metadata objects for API responses.
 * Also preserves legacy owner-note local attachments (filename/path) for display.
 */
async function enrichNotesAttachments(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return notes || [];

  const metaIdsToFetch = [];
  for (const note of notes) {
    const plain = note && typeof note.toObject === 'function' ? note.toObject() : { ...note };
    for (const att of plain.attachments || []) {
      if (isLegacyLocalNoteAttachment(att)) continue;
      if (att && typeof att === 'object' && (att.originalName || att.key)) continue;
      const metaId = att?._id || att;
      if (metaId) metaIdsToFetch.push(String(metaId));
    }
  }

  const metaById = new Map();
  if (metaIdsToFetch.length > 0) {
    const uniqueIds = [...new Set(metaIdsToFetch)];
    const metas = await DocumentMetadata.find({ _id: { $in: uniqueIds } }).lean();
    for (const m of metas) metaById.set(String(m._id), m);
  }

  const urlCache = new Map();
  const urlFetchPromises = [];
  for (const [id] of metaById) {
    urlFetchPromises.push(
      documentsService.getPresignedUrl(id, 3600)
        .then((url) => urlCache.set(id, url))
        .catch(() => {}),
    );
  }
  if (urlFetchPromises.length > 0) await Promise.all(urlFetchPromises);

  return notes.map((note) => {
    const plain = note && typeof note.toObject === 'function' ? note.toObject() : { ...note };
    const rawAttachments = plain.attachments;
    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return plain;

    const resolved = [];
    for (const att of rawAttachments) {
      if (isLegacyLocalNoteAttachment(att)) {
        const legacyId = String(att._id || att.id || '');
        if (!legacyId) continue;
        resolved.push({
          _id: legacyId,
          originalName: att.filename || path.basename(att.path || '') || 'Attachment',
          contentType: att.mimetype || 'application/octet-stream',
          size: att.size,
          uploadedAt: att.uploadedAt || att.createdAt,
          legacyLocal: true,
          unavailable: true,
        });
        continue;
      }

      let meta = null;
      if (att && typeof att === 'object' && (att.originalName || att.key)) {
        meta = att;
      } else {
        const metaId = att?._id || att;
        if (metaId) meta = metaById.get(String(metaId)) || null;
      }
      if (!meta) continue;
      const metaId = String(meta._id || meta.id);
      resolved.push({
        _id: metaId,
        originalName: meta.originalName || 'Attachment',
        contentType: meta.contentType,
        size: meta.size,
        uploadedAt: meta.createdAt,
        url: urlCache.get(metaId),
      });
    }
    plain.attachments = resolved;
    return plain;
  });
}

module.exports = {
  enrichNotesAttachments,
};
