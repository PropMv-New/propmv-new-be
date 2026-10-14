/**
 * ------------------------------------------------------------------
 * File: notify.js
 * Module: Src Common Notifications
 *
 * Purpose:
 * Backend utility/module providing helper functions for notify.
 *
 * Used By:
 * notifications
 * ------------------------------------------------------------------
 */

/**
 * notify(event, data, recipients, metadata?)
 *
 * The single entry point for sending notifications anywhere in the app.
 *
 * @param {object}          event      - An event object from notificationEvents.js
 * @param {object}          data       - Template data used to build the message (e.g. { propertyName, unitName })
 * @param {string|string[]} recipients - One userId or an array of userIds to notify
 * @param {object}          [metadata] - Optional extra context stored with the notification
 *
 * One DB record is created per recipient so each user can independently
 * track their own read/unread state.
 *
 * Errors are caught and logged - a notification failure never throws to the caller.
 *
 * Performance note: HTTP delivery is awaited here so callers that rely on
 * completion ordering (e.g. note reminders marking notified after send) keep
 * working. On latency-sensitive API paths, queue work with setImmediate /
 * *InBackground helpers before calling notify() so the request is not blocked.
 *
 * Usage examples:
 *
 *   const { notify, EVENTS } = require('../common/notifications');
 *
 *   await notify(EVENTS.PROPERTY_CREATED, { propertyName: 'Sunset Villa' }, landlordId);
 *
 *   await notify(
 *     EVENTS.LEASE_CREATED,
 *     { unitName: 'Unit 2A', propertyName: 'Sunset Villa' },
 *     [landlordId, tenant1Id, tenant2Id],
 *     { leaseId: lease._id.toString() }
 *   );
 */

const crypto = require('crypto');
const notificationClient = require('../../integrations/notification');
const logger = require('../../common/logger');

/**
 * Build a deterministic notification id for idempotent delivery per recipient.
 * Format: uuid v5-style hash of eventType + idempotencyKey + userId.
 */
function buildNotificationId(eventType, userId, idempotencyKey) {
  const seed = `${eventType}:${idempotencyKey}:${userId}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

/** In-app event types that Vendor portal users may receive. */
const VENDOR_PORTAL_NOTIFICATION_TYPES = new Set([
  'maintenance_request',
  'vendor_invoice_created',
  'vendor_invoice_updated',
  'vendor_invoice_deleted',
  'vendor_invoice_comment_added',
  'vendor_assigned',
]);

const notify = async (event, data = {}, recipients, metadata = {}, options = {}) => {
  // ── Validate event ──────────────────────────────────────────────────────────
  if (!event || typeof event.type !== 'string' || typeof event.message !== 'function') {
    logger.warn('Invalid event passed to notify - skipping', { event });
    return;
  }

  // ── Normalise recipients to a deduplicated array of non-empty strings ───────
  let userIds = (Array.isArray(recipients) ? recipients : [recipients])
    .map((id) => (id ? String(id).trim() : ''))
    .filter(Boolean)
    .filter((id, idx, arr) => arr.indexOf(id) === idx); // deduplicate

  // Vendors only receive maintenance + vendor-invoice (+ ticket assign) notices.
  // Strip Vendor-role users from every other module (property, owner invoice, expense, docs, …).
  if (!VENDOR_PORTAL_NOTIFICATION_TYPES.has(event.type) && userIds.length > 0) {
    try {
      const { excludeVendorUserIds } = require('../helpers/hoaRecipientResolver');
      userIds = await excludeVendorUserIds(userIds);
    } catch (err) {
      logger.warn('Vendor recipient filter skipped', { type: event.type, err: err?.message || err });
    }
  }

  if (userIds.length === 0) {
    logger.warn('notify called with no valid recipients - skipping', { type: event.type });
    return;
  }

  // ── Build message once (same for all recipients) ────────────────────────────
  let message;
  try {
    message = event.message(data);
  } catch (err) {
    logger.error('Failed to build notification message', { type: event.type, err: err.message });
    return;
  }

  const idempotencyKey = options.idempotencyKey
    || metadata.idempotencyKey
    || metadata.entityId
    || event.type;

  // ── Dispatch one record per recipient ───────────────────────────────────────
  // Use Promise.allSettled so one failure doesn't block the others
  const results = await Promise.allSettled(
    userIds.map((userId) =>
      notificationClient.sendNotification({
        notificationId: buildNotificationId(event.type, userId, idempotencyKey),
        userId,
        title: event.title,
        message,
        type: event.type,
        priority: event.priority || 'medium',
        metadata: {
          ...metadata,
          eventData: data,
          idempotencyKey: `${idempotencyKey}:${userId}`,
        },
      })
    )
  );

  // Log any individual failures without throwing
  results.forEach((result, idx) => {
    if (result.status === 'rejected') {
      logger.error('Failed to send notification to user', {
        userId: userIds[idx],
        type: event.type,
        err: result.reason?.message || result.reason,
      });
    }
  });
};

module.exports = notify;
