'use strict';

const payloadConfig = require('../../../../../config/payload.config');
const logger = require('../../../../../common/logger');

/**
 * Fire-and-forget Payload mirror sync when a PropMV invoice balance/due/status changes.
 * Lazy-requires sync service to avoid circular imports with invoice helpers.
 */
function schedulePayloadAutopayMirrorSync(invoiceId, { reason = '' } = {}) {
  if (!payloadConfig.payload?.ownerAutopayEnabled) return;
  const id = String(invoiceId || '').trim();
  if (!id) return;

  setImmediate(() => {
    try {
      const { syncInvoiceIfOwnerEnrolled } = require('../service/payloadInvoiceSync.service');
      syncInvoiceIfOwnerEnrolled(id).catch((err) => {
        logger.warn('[PayloadAutopaySync] Event-driven mirror sync failed', {
          invoiceId: id,
          reason,
          message: err.message,
        });
      });
    } catch (err) {
      logger.warn('[PayloadAutopaySync] Failed to schedule mirror sync', {
        invoiceId: id,
        reason,
        message: err.message,
      });
    }
  });
}

module.exports = {
  schedulePayloadAutopayMirrorSync,
};
