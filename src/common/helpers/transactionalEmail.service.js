/**
 * ------------------------------------------------------------------
 * File: transactionalEmail.service.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoiceLifecycleEmail.service, maintenanceEmailHelper, actionUpdateEmail.service
 * ------------------------------------------------------------------
 */
const EmailDeliveryLog = require('../models/emailDeliveryLog.model');
const emailHelper = require('./emailHelper');
const { isEmailTemplateEnabled } = require('./emailTemplateFlags');
const logger = require('../logger');

/**
 * build Event Key
 *
 * Performs logic operations for buildEventKey.
 *
 * @param ...parts - Request/input argument
 * @returns Operations result
 */
function buildEventKey(...parts) {
  return parts
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter(Boolean)
    .join(':');
}

async function wasAlreadySent(eventKey) {
  if (!eventKey) return false;
  const existing = await EmailDeliveryLog.findOne({ eventKey, status: 'sent' }).lean();
  return Boolean(existing);
}

/**
 * Send a templated email once per eventKey (deduplicated).
 * Logs success/failure to EmailDeliveryLog for troubleshooting.
 */
async function sendTransactionalEmail({
  eventKey,
  type,
  toEmail,
  data = {},
  options = {},
  entityType = '',
  entityId = '',
  metadata = null,
  skipDuplicateCheck = false,
}) {
  if (!toEmail) {
    throw new Error('Transactional email recipient is required');
  }

  const templateName = options.template || type;

  if (!isEmailTemplateEnabled(templateName)) {
    logger.info(
      `[TransactionalEmail] Skipped (disabled by config): template=${templateName} to=${toEmail}`
    );
    if (eventKey) {
      await EmailDeliveryLog.create({
        eventKey,
        templateName,
        recipientEmail: toEmail,
        entityType,
        entityId: entityId ? String(entityId) : '',
        status: 'skipped_disabled',
        metadata,
      }).catch(() => {});
    }
    return { sent: false, skipped: true, reason: 'disabled' };
  }

  if (!skipDuplicateCheck && eventKey && (await wasAlreadySent(eventKey))) {
    await EmailDeliveryLog.create({
      eventKey,
      templateName,
      recipientEmail: toEmail,
      entityType,
      entityId: entityId ? String(entityId) : '',
      status: 'skipped_duplicate',
      metadata,
    }).catch(() => {});
    return { sent: false, skipped: true, reason: 'duplicate' };
  }

  try {
    const delivered = await emailHelper.sendEmail(type, toEmail, data, {
      ...options,
      template: templateName,
      origin: options.origin || 'system',
    });
    if (delivered === false) {
      if (eventKey) {
        await EmailDeliveryLog.create({
          eventKey,
          templateName,
          recipientEmail: toEmail,
          entityType,
          entityId: entityId ? String(entityId) : '',
          status: 'skipped_disabled',
          metadata,
        }).catch(() => {});
      }
      return { sent: false, skipped: true, reason: 'disabled' };
    }
    if (eventKey) {
      await EmailDeliveryLog.create({
        eventKey,
        templateName,
        recipientEmail: toEmail,
        entityType,
        entityId: entityId ? String(entityId) : '',
        status: 'sent',
        metadata,
      });
    }
    return { sent: true, skipped: false };
  } catch (err) {
    if (eventKey) {
      await EmailDeliveryLog.create({
        eventKey,
        templateName,
        recipientEmail: toEmail,
        entityType,
        entityId: entityId ? String(entityId) : '',
        status: 'failed',
        errorMessage: err.message || String(err),
        metadata,
      }).catch(() => {});
    }
    throw err;
  }
}

const { enqueueOrRunInBackground } = require('../jobs/enqueue');
const { JOB_TYPES } = require('../jobs/constants');
const { buildJobIdempotencyKey } = require('../jobs/idempotency');

/**
 * send Transactional Email In Background
 *
 * Performs logic operations for sendTransactionalEmailInBackground.
 *
 * @param payload - Request/input argument
 * @returns Operations result
 */
function sendTransactionalEmailInBackground(payload = {}) {
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_TRANSACTIONAL,
    entityType: payload.entityType || '',
    entityId: payload.entityId || '',
    recipientId: payload.toEmail || '',
    idempotencyKey: payload.eventKey || buildJobIdempotencyKey(
      'EMAIL_TRANSACTIONAL',
      payload.type,
      payload.toEmail,
      payload.entityId
    ),
    payload,
    run: () => sendTransactionalEmail(payload),
  });
}

module.exports = {
  sendTransactionalEmail,
  sendTransactionalEmailInBackground,
  buildEventKey,
  wasAlreadySent,
};
