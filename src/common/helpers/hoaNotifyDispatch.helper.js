/**
 * Shared HOA in-app notification dispatcher.
 *
 * Document uploads already deliver via setImmediate (they do not wait on the
 * background job worker). Other HOA modules were enqueueing NOTIFY_IN_APP jobs,
 * which never appear in the bell when workers/Redis are unavailable.
 *
 * Every HOA in-app notify path must use this helper so delivery matches documents.
 */

const logger = require('../logger');
const { notify } = require('../notifications');

function toIdString(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value).trim();
}

function extractHoaIdFromNotification(notification = {}) {
  const meta = notification.metadata || notification.meta || {};
  const nested = meta.eventData || meta.data || {};
  const hoaId = meta.hoaId || nested.hoaId || notification.hoaId;
  return hoaId ? String(hoaId) : null;
}

function withHoaMetadata(metadata = {}, hoaId) {
  const id = toIdString(hoaId) || toIdString(metadata.hoaId);
  if (!id) return { ...metadata };
  return { ...metadata, hoaId: id };
}

function runHoaNotifyInBackground(task, label = 'hoa in-app notify') {
  try {
    setImmediate(() => {
      Promise.resolve()
        .then(task)
        .catch((err) => logger.error(`background ${label} failed`, err));
    });
  } catch (err) {
    logger.error(`failed to queue background ${label}`, err);
  }
}

/**
 * Send an in-app notification through the shared pipeline.
 * HTTP callers should wrap with runHoaNotifyInBackground so the request is not blocked.
 */
async function dispatchHoaInAppNotification(event, data, recipients, metadata = {}, options = {}) {
  const hoaId = toIdString(metadata.hoaId) || toIdString(data?.hoaId);
  return notify(event, data, recipients, withHoaMetadata(metadata, hoaId), options);
}

module.exports = {
  toIdString,
  extractHoaIdFromNotification,
  withHoaMetadata,
  runHoaNotifyInBackground,
  dispatchHoaInAppNotification,
};
