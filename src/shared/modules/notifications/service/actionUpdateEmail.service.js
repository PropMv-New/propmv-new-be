/**
 * ------------------------------------------------------------------
 * File: actionUpdateEmail.service.js
 * Module: Src Shared Modules Notifications Service
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * maintenance.service, landlordPortalEventEmail.service
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const User = require('../../users/models/user.model');
const logger = require('../../../../common/logger');
const {
  sendTransactionalEmail,
  buildEventKey,
} = require('../../../../common/helpers/transactionalEmail.service');
const { formatDateInAppTimezone, formatEmailDateTime } = require('../../../../common/helpers/hoaBillingDates');
const {
  buildMaintenanceTicketPreheader,
  formatMaintenanceStatusLabel,
} = require('../../../../common/helpers/emailDisplayHelper');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('../../../../common/helpers/communityEmailContext.service');
const { ClockService, DateUtil } = require('../../../../common/date');

const MAINTENANCE_ENTITY_TYPE = 'Maintenance Request';

const EVENT_MESSAGE_MAP = {
  maintenance_updated: 'A maintenance request was updated.',
  maintenance_reopened: 'A maintenance ticket was reopened.',
  maintenance_resolved: 'A maintenance ticket was marked as resolved.',
  maintenance_comment_added: 'A comment was added to a maintenance request.',
  maintenance_note_added: 'A note was added to a maintenance request.',
  maintenance_documents_updated: 'Maintenance request documents were updated.',
};

/**
 * "Update:" emails are sent only for maintenance workflows.
 */
function isMaintenanceActionUpdatePayload({
  entityType = '',
  eventKey = '',
} = {}) {
  if (entityType === MAINTENANCE_ENTITY_TYPE) return true;
  if (eventKey && String(eventKey).startsWith('maintenance_')) return true;
  return false;
}

/**
 * get Default Event Message
 *
 * Performs logic operations for getDefaultEventMessage.
 *
 * @param eventKey - Request/input argument
 * @returns Operations result
 */
function getDefaultEventMessage(eventKey) {
  return EVENT_MESSAGE_MAP[eventKey] || 'A maintenance request was updated.';
}

function normalizeRecipientId(value) {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

/**
 * get Portal Base Url
 *
 * Performs logic operations for getPortalBaseUrl.
 *
 * @returns Operations result
 */
function getPortalBaseUrl() {
  return String(
    process.env.HOA_PORTAL_URL ||
      process.env.HOA_FRONTEND_BASE_URL ||
      process.env.FRONTEND_BASE_URL ||
      process.env.APP_URL ||
      'https://app.propmv.com'
  ).replace(/\/$/, '');
}

/**
 * build Maintenance Ticket Url
 *
 * Performs logic operations for buildMaintenanceTicketUrl.
 *
 * @param entityId - Request/input argument
 * @returns Operations result
 */
function buildMaintenanceTicketUrl(entityId) {
  if (!entityId) return `${getPortalBaseUrl()}/maintenance`;
  return `${getPortalBaseUrl()}/maintenance/${encodeURIComponent(String(entityId))}`;
}

/**
 * resolve Maintenance Template
 *
 * Performs logic operations for resolveMaintenanceTemplate.
 *
 * @param eventKey - Request/input argument
 * @returns Operations result
 */
function resolveMaintenanceTemplate(eventKey) {
  if (eventKey === 'maintenance_resolved') {
    return {
      template: 'maintenance-ticket-resolved',
      type: 'maintenance-ticket-resolved',
      subjectPrefix: 'Maintenance resolved',
    };
  }
  if (eventKey === 'maintenance_reopened') {
    return {
      template: 'maintenance-ticket-updated',
      type: 'maintenance-ticket-updated',
      subjectPrefix: 'Maintenance reopened',
    };
  }
  if (eventKey === 'maintenance_comment_added') {
    return {
      template: 'maintenance-ticket-updated',
      type: 'maintenance-ticket-updated',
      subjectPrefix: 'Maintenance comment',
    };
  }
  if (eventKey === 'maintenance_note_added') {
    return {
      template: 'maintenance-ticket-updated',
      type: 'maintenance-ticket-updated',
      subjectPrefix: 'Maintenance note',
    };
  }
  if (eventKey === 'maintenance_documents_updated') {
    return {
      template: 'maintenance-ticket-updated',
      type: 'maintenance-ticket-updated',
      subjectPrefix: 'Maintenance documents',
    };
  }
  return {
    template: 'maintenance-ticket-updated',
    type: 'maintenance-ticket-updated',
    subjectPrefix: 'Maintenance update',
  };
}

async function sendActionUpdateEmail({
  userIds = [],
  eventKey = '',
  eventMessage,
  actorUserId = null,
  entityType = '',
  entityId = '',
  metadata = {},
}) {
  if (!isMaintenanceActionUpdatePayload({ entityType, eventKey })) {
    return { attempted: 0, sent: 0, failed: 0, skipped: true };
  }

  const validUserIds = [...new Set(
    userIds
      .map(normalizeRecipientId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24)
  )];
  if (validUserIds.length === 0) return { attempted: 0, sent: 0, failed: 0 };

  const users = await User.find({
    _id: { $in: validUserIds.map((id) => new mongoose.Types.ObjectId(id)) },
    isDeleted: { $ne: true },
  })
    .select('_id firstName lastName email')
    .lean();

  const actorIdStr = actorUserId ? String(actorUserId) : null;
  const recipients = users.filter((u) => (actorIdStr ? String(u._id) !== actorIdStr : true) && !!u.email);
  const message = eventMessage || getDefaultEventMessage(eventKey);
  const { template, type, subjectPrefix } = resolveMaintenanceTemplate(eventKey);
  const viewTicketUrl = buildMaintenanceTicketUrl(entityId);
  const ticketTitle = metadata?.title ? String(metadata.title) : 'Maintenance request';
  const ticketNumber = metadata?.ticketNumber
    ? String(metadata.ticketNumber)
    : 'N/A';
  const ticketStatus = metadata?.status
    ? formatMaintenanceStatusLabel(String(metadata.status))
    : '';
  const propertyName = metadata?.propertyName ? String(metadata.propertyName) : '';
  const hoaId = metadata?.hoaId || null;
  const communityName = await resolveCommunityName(hoaId, metadata?.communityName);
  const dateKey = formatDateInAppTimezone(ClockService.now()) || DateUtil.toDateOnlyISO(ClockService.now());
  // Activity-specific dedupe (comment/note/doc) so each action can email the same day.
  const dedupeSuffix = metadata?.dedupeKey
    ? String(metadata.dedupeKey)
    : dateKey;
  const baseSubject = `${ticketNumber} - ${subjectPrefix}: ${ticketTitle}`;
  const subject = buildCommunityEmailSubject(baseSubject, communityName);

  let sent = 0;
  let failed = 0;

  for (const user of recipients) {
    const recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
    const dedupeEventKey = buildEventKey(
      'maintenance_email',
      eventKey || 'updated',
      entityId,
      user.email,
      dedupeSuffix
    );

    try {
      const result = await sendTransactionalEmail({
        eventKey: dedupeEventKey,
        type,
        toEmail: user.email,
        data: {
          recipientName,
          eventMessage: message,
          ticketId: entityId ? String(entityId) : 'N/A',
          ticketNumber,
          ticketTitle,
          ticketStatus,
          propertyName,
          viewTicketUrl,
          resolvedAt: formatEmailDateTime(ClockService.now()),
          communityName: communityName || '',
        },
        options: {
          template,
          subject,
          preheaderText: buildMaintenanceTicketPreheader({
            eventMessage: message,
            ticketTitle,
          }),
          hoaId,
          communityName: communityName || null,
        },
        entityType: MAINTENANCE_ENTITY_TYPE,
        entityId,
        metadata: { eventKey },
      });
      if (result.sent) sent += 1;
    } catch (err) {
      failed += 1;
      logger.error('[ActionUpdateEmail] send failed:', user.email, err.message);
    }
  }

  return { attempted: recipients.length, sent, failed };
}

/**
 * notify Action Update In Background
 *
 * Performs logic operations for notifyActionUpdateInBackground.
 *
 * @param payload - Request/input argument
 * @returns Operations result
 */
function notifyActionUpdateInBackground(payload = {}) {
  if (!isMaintenanceActionUpdatePayload(payload)) {
    return;
  }
  setImmediate(async () => {
    try {
      await sendActionUpdateEmail(payload);
    } catch (err) {
      logger.error('[ActionUpdateEmail] background notify failed:', err.message);
    }
  });
}

module.exports = {
  sendActionUpdateEmail,
  notifyActionUpdateInBackground,
  isMaintenanceActionUpdatePayload,
  MAINTENANCE_ENTITY_TYPE,
  buildMaintenanceTicketUrl,
};
