/**
 * ------------------------------------------------------------------
 * File: notify.js
 * Module: Backend Integrations
 *
 * Purpose:
 * Backend utility/module providing helper functions for notify.
 *
 * Used By:
 * notification
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
const notificationClient = require('./notificationClient');
const logger = require('../../common/logger');

const notify = async (event, data = {}, recipients, metadata = {}) => {
  // ── Validate event ──────────────────────────────────────────────────────────
  if (!event || typeof event.type !== 'string' || typeof event.message !== 'function') {
    logger.warn('Invalid event passed to notify - skipping', { event });
    return;
  }

  // ── Normalise recipients to a deduplicated array of non-empty strings ───────
  const userIds = (Array.isArray(recipients) ? recipients : [recipients])
    .map((id) => (id ? String(id).trim() : ''))
    .filter(Boolean)
    .filter((id, idx, arr) => arr.indexOf(id) === idx); // deduplicate

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

  // ── Dispatch one record per recipient ───────────────────────────────────────
  // Use Promise.allSettled so one failure doesn't block the others
  const results = await Promise.allSettled(
    userIds.map((userId) =>
      notificationClient.sendNotification({
        notificationId: crypto.randomUUID(),
        userId,
        title: event.title,
        message,
        type: event.type,
        priority: event.priority || 'medium',
        metadata: { ...metadata, eventData: data },
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
