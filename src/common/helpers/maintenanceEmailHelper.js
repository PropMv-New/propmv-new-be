/**
 * ------------------------------------------------------------------
 * File: maintenanceEmailHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceEmailHelper.
 *
 * Used By:
 * maintenance.service
 * ------------------------------------------------------------------
 */

/**
 * Maintenance Email Helper
 * Sends role-aware emails when a maintenance request is created.
 */

const mongoose = require('mongoose');
const emailHelper = require('./emailHelper');
const User = require('../../shared/modules/users/models/user.model');
const Lease = require('../../portals/landlord/modules/leasing/model/lease.model');
const Property = require('../../portals/landlord/modules/property/model/property.model');
const { unitDisplayNameFromMaintenance } = require('./propertyUnitReference');
const { resolveUserRoleName: resolveCompanyUserRoleName } = require('./companyRoleHelper');
const {
  roleKeyFromName,
  SUBMITTER_LABELS,
  formatCategory,
  buildManagerEmailContent,
  buildTenantEmailContent,
} = require('./maintenanceEmailContent');
const { resolveMaintenanceTicketNumber } = require('../../shared/modules/maintenance/helpers/maintenanceTicketNumber.helper');
const { getTodayYmdInAppTimezone, parseAppYmd, formatEmailDateTime } = require('./hoaBillingDates');
const {
  buildMaintenanceTicketPreheader,
  formatMaintenancePriorityLabel,
  formatMaintenanceStatusLabel,
} = require('./emailDisplayHelper');
const { ClockService } = require('../date');
const {
  sendTransactionalEmail,
  buildEventKey,
} = require('./transactionalEmail.service');
const { loadHoaMemberUserIds } = require('../../middleware/hoaDataIsolation');
const {
  normalizeUserId,
  normalizeRequestedByUserIds,
  shouldEmailMaintenanceRecipient,
  filterMaintenanceNotifyUserIds,
  buildCreatedPartyNotifications,
  loadMaintenancePartyUsers,
} = require('./maintenanceEmailRecipients');
const { notifyMaintenanceCreatedInAppInBackground } = require('./hoaInAppNotify.helper');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('./communityEmailContext.service');

const logger = require('../logger');

/**
 * format Request Date
 *
 * Performs logic operations for formatRequestDate.
 *
 * @param requestDate - Request/input argument
 * @returns Operations result
 */
function formatRequestDate(requestDate) {
  return formatEmailDateTime(requestDate || ClockService.now());
}

function currentYearInAppTimezone() {
  const p = parseAppYmd(getTodayYmdInAppTimezone());
  return p?.y ?? ClockService.now().getUTCFullYear();
}

/**
 * get Maintenance Portal Base Url
 *
 * Performs logic operations for getMaintenancePortalBaseUrl.
 *
 * @param isHoaFlow - Request/input argument
 * @returns Operations result
 */
function getMaintenancePortalBaseUrl(isHoaFlow) {
  const hoaPortal = process.env.HOA_PORTAL_URL || process.env.APP_URL || 'https://app.propmv.com';
  const landlordPortal = process.env.LANDLORD_PORTAL_URL || process.env.APP_URL || 'https://app.propmv.com';
  return String(isHoaFlow ? hoaPortal : landlordPortal).replace(/\/$/, '');
}

/**
 * build Maintenance View Ticket Url
 *
 * Performs logic operations for buildMaintenanceViewTicketUrl.
 *
 * @param maintenanceRequest - Request/input argument
 * @param isHoaFlow - Request/input argument
 * @returns Operations result
 */
function buildMaintenanceViewTicketUrl(maintenanceRequest, isHoaFlow) {
  const base = getMaintenancePortalBaseUrl(isHoaFlow);
  const ticketId = maintenanceRequest?._id;
  if (!ticketId) return `${base}/maintenance`;
  return `${base}/maintenance/${encodeURIComponent(String(ticketId))}`;
}

/**
 * track Emailed Recipient
 *
 * Performs logic operations for trackEmailedRecipient.
 *
 * @param alreadyEmailedEmails - Request/input argument
 * @param email - Request/input argument
 * @returns Operations result
 */
function trackEmailedRecipient(alreadyEmailedEmails, email) {
  if (!email) return;
  alreadyEmailedEmails.add(String(email).trim().toLowerCase());
}

/**
 * was Already Emailed
 *
 * Performs logic operations for wasAlreadyEmailed.
 *
 * @param alreadyEmailedEmails - Request/input argument
 * @param email - Request/input argument
 * @returns Operations result
 */
function wasAlreadyEmailed(alreadyEmailedEmails, email) {
  if (!email) return true;
  return alreadyEmailedEmails.has(String(email).trim().toLowerCase());
}

async function sendMaintenanceCreatedPartyEmail({
  maintenanceRequest,
  recipient,
  eventMessage,
  subject,
  eventKeyPrefix,
  propertyName,
  unitName,
  isHoaFlow,
  hoaId = null,
  communityName = '',
}) {
  if (!recipient?.email) return { sent: false };

  const recipientName = `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || 'there';
  const ticketId = String(maintenanceRequest._id);
  const ticketNumber = resolveMaintenanceTicketNumber(maintenanceRequest);
  const eventKey = buildEventKey(eventKeyPrefix, ticketId, recipient.email);

  const createdByDisplay = maintenanceRequest.createdByDisplay
    || (maintenanceRequest.createdByName
      ? (maintenanceRequest.createdByRole
        ? `${maintenanceRequest.createdByName} (${maintenanceRequest.createdByRole})`
        : maintenanceRequest.createdByName)
      : null);
  const requestedForDisplay = maintenanceRequest.requestedForDisplay
    || maintenanceRequest.requestedForLabel
    || null;

  return sendTransactionalEmail({
    eventKey,
    type: 'maintenance-ticket-created',
    toEmail: recipient.email,
    data: {
      recipientName,
      eventMessage,
      ticketId,
      ticketNumber,
      ticketTitle: maintenanceRequest.title || 'Maintenance request',
      ticketStatus: formatMaintenanceStatusLabel(maintenanceRequest.status || 'Open'),
      issue: formatCategory(maintenanceRequest),
      description: maintenanceRequest.description || '',
      priority: formatMaintenancePriorityLabel(maintenanceRequest.priority || 'Medium'),
      category: formatCategory(maintenanceRequest),
      propertyName: propertyName || 'N/A',
      unitName: unitName || '',
      createdByDisplay,
      requestedForDisplay,
      viewTicketUrl: buildMaintenanceViewTicketUrl(maintenanceRequest, isHoaFlow),
      communityName: communityName || '',
    },
    options: {
      template: 'maintenance-ticket-created',
      subject: isHoaFlow
        ? buildCommunityEmailSubject(subject, communityName)
        : subject,
      preheaderText: buildMaintenanceTicketPreheader({
        eventMessage,
        ticketTitle: maintenanceRequest.title,
      }),
      hoaId: isHoaFlow ? hoaId : null,
      communityName: communityName || null,
    },
    entityType: 'Maintenance Request',
    entityId: maintenanceRequest._id,
    metadata: { audience: eventKeyPrefix },
  }).catch((err) => {
    logger.error('Created-party notification failed:', { email: recipient.email, error: err.message });
    return { sent: false };
  });
}

async function notifyMaintenanceCreatedPartyEmails({
  maintenanceRequest,
  propertyName,
  unitName,
  isHoaFlow,
  hoaId = null,
  communityName = '',
  alreadyEmailedEmails = new Set(),
}) {
  const rawCreatorId = normalizeUserId(maintenanceRequest.createdBy);
  const creatorId = shouldEmailMaintenanceRecipient(maintenanceRequest, rawCreatorId)
    ? rawCreatorId
    : null;
  const allRequestedByIds = normalizeRequestedByUserIds(maintenanceRequest.requestedBy);
  // Only include requestedBy recipients when Notify Requester is enabled.
  // A self-requesting creator is also suppressed when the toggle is disabled.
  const requestedByIds = maintenanceRequest.notifyTenant ? allRequestedByIds : [];
  const createdByDisplay = maintenanceRequest.createdByDisplay
    || (maintenanceRequest.createdByName
      ? (maintenanceRequest.createdByRole
        ? `${maintenanceRequest.createdByName} (${maintenanceRequest.createdByRole})`
        : maintenanceRequest.createdByName)
      : null);
  const requestedForDisplay = maintenanceRequest.requestedForDisplay
    || maintenanceRequest.requestedForLabel
    || null;
  const isSelfCreated = maintenanceRequest.isSelfCreated ?? (
    creatorId != null
    && allRequestedByIds.length > 0
    && allRequestedByIds.every((id) => String(id) === String(creatorId))
  );
  const notifications = buildCreatedPartyNotifications({
    creatorId,
    requestedByIds,
    createdByDisplay,
    requestedForDisplay,
    isSelfCreated,
  });
  if (!notifications.length) return { sent: 0, attempted: 0 };

  const users = await loadMaintenancePartyUsers(notifications.map((row) => row.userId));
  const usersById = new Map(users.map((user) => [String(user._id), user]));
  const ticketLabel = maintenanceRequest.title || 'Maintenance request';
  const ticketNumber = resolveMaintenanceTicketNumber(maintenanceRequest);
  const ticketRef = ticketNumber || ticketLabel;

  let sent = 0;
  for (const notice of notifications) {
    const user = usersById.get(String(notice.userId));
    if (!user?.email || wasAlreadyEmailed(alreadyEmailedEmails, user.email)) continue;

    const result = await sendMaintenanceCreatedPartyEmail({
      maintenanceRequest,
      recipient: user,
      eventMessage: notice.eventMessage,
      subject: `${ticketRef} - Maintenance ticket ${notice.subjectSuffix}`,
      eventKeyPrefix: notice.eventKeyPrefix,
      propertyName,
      unitName,
      isHoaFlow,
      hoaId,
      communityName,
    });
    if (result?.sent) {
      sent += 1;
      trackEmailedRecipient(alreadyEmailedEmails, user.email);
    }
  }

  return { sent, attempted: notifications.length };
}

async function notifyMaintenanceAssigneeOnCreate({
  maintenanceRequest,
  propertyName,
  unitName,
  isHoaFlow,
  hoaId = null,
  communityName = '',
  alreadyEmailedEmails = new Set(),
}) {
  const assignedRef = maintenanceRequest.assignedTo;
  const assignedId = normalizeUserId(assignedRef);
  if (
    !assignedId
    || !shouldEmailMaintenanceRecipient(maintenanceRequest, assignedId)
  ) return { sent: 0 };

  let assignee =
    assignedRef && typeof assignedRef === 'object' && assignedRef.email ? assignedRef : null;
  if (!assignee) {
    assignee = await User.findById(assignedId).select('firstName lastName email').lean();
  }
  if (!assignee?.email || wasAlreadyEmailed(alreadyEmailedEmails, assignee.email)) {
    return { sent: 0 };
  }

  const ticketLabel = maintenanceRequest.title || 'Maintenance request';
  const ticketNumber = resolveMaintenanceTicketNumber(maintenanceRequest);
  const ticketRef = ticketNumber || ticketLabel;
  const ticketId = String(maintenanceRequest._id);
  const result = await sendMaintenanceCreatedPartyEmail({
    maintenanceRequest,
    recipient: assignee,
    eventMessage: `You have been assigned to maintenance ticket ${ticketRef}.`,
    subject: `Assigned: ${ticketRef}`,
    eventKeyPrefix: 'maintenance_created_assignee',
    propertyName,
    unitName,
    isHoaFlow,
    hoaId,
    communityName,
  });
  if (result?.sent) trackEmailedRecipient(alreadyEmailedEmails, assignee.email);
  return { sent: result?.sent ? 1 : 0 };
}

async function resolveMaintenancePropertyForEmail(maintenanceRequest) {
  const propertyId = maintenanceRequest?.property_id;
  if (!propertyId) return null;
  const fields = 'name address landlord_id unitDetails hoaId';
  const property = await Property.findById(propertyId).select(fields).lean();
  if (property) return property;
  try {
    const HOAProperty = require('../../portals/hoa-board/modules/property/model/property.model');
    return await HOAProperty.findById(propertyId).select(fields).lean();
  } catch {
    return null;
  }
}

function displayUserName(user) {
  if (!user) return '';
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || '';
}

async function sendMaintenanceVendorAssignedEmail(maintenanceRequest, options = {}) {
  try {
    const assignedRef = maintenanceRequest?.assignedTo;
    const assignedId = normalizeUserId(assignedRef);
    if (!assignedId) return { sent: false };

    let vendor = assignedRef && typeof assignedRef === 'object' && assignedRef.email
      ? assignedRef
      : null;
    if (!vendor) {
      vendor = await User.findById(assignedId).select('firstName lastName email').lean();
    }
    if (!vendor?.email) {
      logger.warn('Vendor assignment email skipped - vendor has no email', {
        maintenanceId: maintenanceRequest?._id,
        assignedId,
      });
      return { sent: false };
    }

    const property = await resolveMaintenancePropertyForEmail(maintenanceRequest);
    const unitName = property
      ? unitDisplayNameFromMaintenance(property, maintenanceRequest)
      : maintenanceRequest.units || maintenanceRequest.unitName || '';
    const propertyName = property?.name || maintenanceRequest.propertyName || 'N/A';
    const isHoaFlow = Boolean(property?.hoaId || maintenanceRequest.hoaId);
    const hoaId = property?.hoaId || maintenanceRequest.hoaId || null;
    const communityName = isHoaFlow && hoaId ? await resolveCommunityName(hoaId) : '';

    let assignedByDisplay = '';
    if (options.actorUserId) {
      const actor = await User.findById(options.actorUserId).select('firstName lastName email').lean();
      assignedByDisplay = displayUserName(actor);
    }

    const ticketNumber = resolveMaintenanceTicketNumber(maintenanceRequest);
    const ticketTitle = maintenanceRequest.title || 'Maintenance request';
    const ticketRef = ticketNumber || ticketTitle;
    const ticketId = String(maintenanceRequest._id);
    const vendorName = displayUserName(vendor) || 'there';
    const eventMessage = `You have been assigned to maintenance ticket ${ticketRef}.`;

    return sendTransactionalEmail({
      eventKey: buildEventKey('maintenance_vendor_assigned', ticketId, vendor.email),
      type: 'maintenance-ticket-assigned',
      toEmail: vendor.email,
      data: {
        recipientName: vendorName,
        eventMessage,
        ticketId,
        ticketNumber,
        ticketTitle,
        ticketStatus: formatMaintenanceStatusLabel(maintenanceRequest.status || 'Open'),
        issue: formatCategory(maintenanceRequest),
        description: maintenanceRequest.description || '',
        priority: formatMaintenancePriorityLabel(maintenanceRequest.priority || 'Medium'),
        category: formatCategory(maintenanceRequest),
        propertyName,
        unitName: unitName || '',
        assignedToDisplay: vendorName,
        assignedByDisplay,
        viewTicketUrl: buildMaintenanceViewTicketUrl(maintenanceRequest, isHoaFlow),
        communityName: communityName || '',
      },
      options: {
        template: 'maintenance-ticket-assigned',
        subject: isHoaFlow
          ? buildCommunityEmailSubject(`Assigned: ${ticketRef}`, communityName)
          : `Assigned: ${ticketRef}`,
        preheaderText: buildMaintenanceTicketPreheader({
          eventMessage,
          ticketTitle,
        }),
        hoaId: isHoaFlow ? hoaId : null,
        communityName: communityName || null,
      },
      entityType: 'Maintenance Request',
      entityId: maintenanceRequest._id,
      metadata: { audience: 'maintenance_vendor_assigned' },
    }).catch((err) => {
      logger.error('Vendor assignment email failed:', { email: vendor.email, error: err.message });
      return { sent: false };
    });
  } catch (err) {
    logger.error('Error in sendMaintenanceVendorAssignedEmail:', err);
    return { sent: false };
  }
}

async function notifyHoaBoardMembersOnCreate({
  maintenanceRequest,
  property,
  propertyName,
  unitName,
  creatorId,
  submitterRoleKey,
  submitterRoleLabel,
  creatorName,
  createdByDisplay,
  requestedForDisplay,
  requestedByName,
  isHoaFlow,
  alreadyEmailedEmails = new Set(),
  options = {},
}) {
  const hoaId = property?.hoaId || maintenanceRequest.hoaId;
  if (!hoaId) {
    logger.warn('notifyHoaBoardMembersOnCreate skipped - no hoaId', {
      maintenanceId: maintenanceRequest?._id,
    });
    return { sent: 0 };
  }

  const memberIds = await loadHoaMemberUserIds(hoaId);
  if (!memberIds.length) {
    logger.warn('notifyHoaBoardMembersOnCreate skipped - no active board members', {
      maintenanceId: maintenanceRequest?._id,
      hoaId: String(hoaId),
    });
    return { sent: 0 };
  }

  const rbIdList = normalizeRequestedByUserIds(maintenanceRequest.requestedBy);
  const isSelfSubmitted = maintenanceRequest.isSelfCreated ?? (
    creatorId != null && rbIdList.some((id) => String(id) === String(creatorId))
  );

  const hoaPortal = process.env.HOA_PORTAL_URL || process.env.APP_URL || 'https://app.propmv.com';
  const baseUrls = {
    dashboardUrl: options.dashboardUrl || `${hoaPortal}/maintenance`,
    tenantPortalUrl: options.tenantPortalUrl || `${hoaPortal}/maintenance`,
    settingsUrl: options.settingsUrl || `${process.env.APP_URL || hoaPortal}/settings/notifications`,
    supportUrl: options.supportUrl || `${process.env.APP_URL || hoaPortal}/support`,
    privacyUrl: options.privacyUrl || `${process.env.APP_URL || hoaPortal}/privacy-policy`,
    currentYear: currentYearInAppTimezone(),
  };

  const memberObjectIds = memberIds
    .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  const boardUsers = memberObjectIds.length
    ? await User.find({
      _id: { $in: memberObjectIds },
      isDeleted: { $ne: true },
      email: { $exists: true, $nin: [null, ''] },
    })
      .select('firstName lastName email')
      .lean()
    : [];

  if (!boardUsers.length) {
    logger.warn('notifyHoaBoardMembersOnCreate skipped - board members have no email', {
      maintenanceId: maintenanceRequest?._id,
      hoaId: String(hoaId),
      memberCount: memberIds.length,
    });
    return { sent: 0 };
  }

  const communityName = isHoaFlow ? await resolveCommunityName(hoaId) : '';

  let sent = 0;
  for (const boardUser of boardUsers) {
    if (!boardUser?.email || wasAlreadyEmailed(alreadyEmailedEmails, boardUser.email)) continue;
    if (creatorId && String(boardUser._id) === String(creatorId)) continue;
    if (!shouldEmailMaintenanceRecipient(maintenanceRequest, boardUser._id)) continue;

    const managerContent = buildManagerEmailContent({
      submitterRoleKey,
      submitterRoleLabel,
      requestedByName: requestedForDisplay || requestedByName,
      createdByDisplay,
      requestedForDisplay,
      isSelfSubmitted,
      recipientName: `${boardUser.firstName || ''} ${boardUser.lastName || ''}`.trim() || 'there',
      propertyName: property?.name || propertyName,
      unitName,
      requestTitle: maintenanceRequest.title,
      isHoaFlow,
      notifyTenant: maintenanceRequest.notifyTenant,
    });

    const emailData = {
      ticketNumber: resolveMaintenanceTicketNumber(maintenanceRequest),
      requestTitle: maintenanceRequest.title,
      description: maintenanceRequest.description || '-',
      category: formatCategory(maintenanceRequest),
      priority: formatMaintenancePriorityLabel(maintenanceRequest.priority || 'Medium'),
      isUrgent: Boolean(maintenanceRequest.isUrgent),
      status: formatMaintenanceStatusLabel(maintenanceRequest.status || 'Open'),
      propertyName: property?.name || propertyName || 'N/A',
      unitName: unitName || '-',
      tenantName: '-',
      requestedByName: requestedForDisplay || requestedByName,
      createdByDisplay,
      requestedForDisplay,
      createdAt: formatRequestDate(maintenanceRequest.request_date),
      notifyTenant: maintenanceRequest.notifyTenant,
      landlordName: `${boardUser.firstName || ''} ${boardUser.lastName || ''}`.trim(),
      viewTicketUrl: buildMaintenanceViewTicketUrl(maintenanceRequest, true),
      ...managerContent,
      ...baseUrls,
    };

    try {
      await emailHelper.sendEmail(
        'maintenance-request-created-landlord',
        boardUser.email,
        emailData,
        {
          subject: isHoaFlow
            ? buildCommunityEmailSubject(managerContent.emailSubject, communityName)
            : managerContent.emailSubject,
          preheaderText: buildMaintenanceTicketPreheader({
            eventMessage: managerContent.emailSubject,
            ticketTitle: maintenanceRequest.title,
          }),
          hoaId,
          communityName: communityName || null,
          senderUserId: creatorId || null,
        }
      );
      trackEmailedRecipient(alreadyEmailedEmails, boardUser.email);
      sent += 1;
    } catch (err) {
      logger.error('Failed to send HOA board maintenance notification:', {
        email: boardUser.email,
        maintenanceId: maintenanceRequest?._id,
        error: err.message,
      });
    }
  }

  return { sent };
}

async function sendMaintenanceRequestCreatedEmail(maintenanceRequest, options = {}) {
  try {
    const property = await resolveMaintenancePropertyForEmail(maintenanceRequest);

    if (!property) {
      logger.warn('Property not found for maintenance request email (continuing with ticket hoaId):', {
        maintenanceId: maintenanceRequest._id,
        propertyId: maintenanceRequest.property_id,
      });
    }

    const displayUnitName = property
      ? unitDisplayNameFromMaintenance(property, maintenanceRequest)
      : maintenanceRequest.units || maintenanceRequest.unitName || 'N/A';
    const propertyName = property?.name || 'N/A';

    const rbIdList = normalizeRequestedByUserIds(maintenanceRequest.requestedBy);
    const requestedByUsers =
      rbIdList.length > 0
        ? await loadMaintenancePartyUsers(rbIdList)
        : [];

    const requestedByName =
      requestedByUsers.length > 0
        ? requestedByUsers
          .map((u) => `${u.firstName || ''} ${u.lastName || ''}`.trim())
          .filter(Boolean)
          .join(', ') || 'Unknown'
        : 'Unknown';

    const creatorId = normalizeUserId(maintenanceRequest.createdBy);
    let creatorUser = null;
    if (creatorId) {
      creatorUser = await User.findById(creatorId)
        .select('firstName lastName email companyRoleId role companyId')
        .lean();
    }

    const creatorRoleName = maintenanceRequest.createdByRole
      || (creatorUser ? await resolveCompanyUserRoleName(creatorUser) : '');
    const submitterRoleKey = roleKeyFromName(creatorRoleName);
    const submitterRoleLabel = SUBMITTER_LABELS[submitterRoleKey] || creatorRoleName || 'User';
    const creatorName = maintenanceRequest.createdByName
      || (creatorUser ? `${creatorUser.firstName || ''} ${creatorUser.lastName || ''}`.trim() : '')
      || requestedByName;
    const createdByDisplay = maintenanceRequest.createdByDisplay
      || (creatorName && creatorRoleName ? `${creatorName} (${submitterRoleLabel})` : creatorName);
    const requestedForDisplay = maintenanceRequest.requestedForDisplay
      || maintenanceRequest.requestedForLabel
      || requestedByName;

    const isHoaFlow =
      Boolean(property?.hoaId || maintenanceRequest.hoaId) ||
      submitterRoleKey === 'hoa_owner' ||
      submitterRoleKey === 'hoa_board' ||
      Boolean(maintenanceRequest.primaryRequestType || maintenanceRequest.subRequestType);

    let hoaId = property?.hoaId || maintenanceRequest.hoaId || null;
    if (!hoaId && maintenanceRequest.property_id) {
      // Last-chance community scope from HOA property collection.
      try {
        const HOAProperty = require('../../portals/hoa-board/modules/property/model/property.model');
        const hoaProp = await HOAProperty.findById(maintenanceRequest.property_id)
          .select('hoaId name')
          .lean();
        if (hoaProp?.hoaId) hoaId = hoaProp.hoaId;
      } catch (err) {
        logger.warn('Failed to resolve hoaId from HOAProperty for maintenance email', {
          maintenanceId: maintenanceRequest._id,
          error: err.message,
        });
      }
    }

    const communityName = isHoaFlow && hoaId ? await resolveCommunityName(hoaId) : '';

    const alreadyEmailedEmails = new Set();

    await notifyMaintenanceCreatedPartyEmails({
      maintenanceRequest,
      propertyName,
      unitName: displayUnitName,
      isHoaFlow,
      hoaId,
      communityName,
      alreadyEmailedEmails,
    });

    await notifyMaintenanceAssigneeOnCreate({
      maintenanceRequest,
      propertyName,
      unitName: displayUnitName,
      isHoaFlow,
      hoaId,
      communityName,
      alreadyEmailedEmails,
    });

    if (isHoaFlow) {
      if (!hoaId) {
        logger.error('HOA maintenance create email skipped board delivery - missing hoaId', {
          maintenanceId: maintenanceRequest._id,
          submitterRoleKey,
          propertyId: maintenanceRequest.property_id,
        });
      } else {
        const boardResult = await notifyHoaBoardMembersOnCreate({
          maintenanceRequest,
          property: property || { hoaId, name: propertyName },
          propertyName,
          unitName: displayUnitName,
          creatorId,
          creatorRoleName,
          submitterRoleKey,
          submitterRoleLabel,
          creatorName,
          createdByDisplay,
          requestedForDisplay,
          requestedByName,
          isHoaFlow,
          alreadyEmailedEmails,
          options,
        });

        logger.info('HOA board maintenance create emails finished', {
          maintenanceId: maintenanceRequest._id,
          hoaId: String(hoaId),
          boardEmailsSent: boardResult?.sent || 0,
        });
      }

      // In-app is also fired on create commit; idempotent if already sent.
      notifyMaintenanceCreatedInAppInBackground(maintenanceRequest, creatorId, {
        unitName: displayUnitName,
      });
      logger.info('✓ HOA maintenance create email path completed', {
        maintenanceId: maintenanceRequest._id,
        hoaId: hoaId ? String(hoaId) : null,
      });
      return;
    }

    if (!property?.landlord_id) {
      logger.info('Maintenance request emails completed (no property manager recipient)', {
        maintenanceId: maintenanceRequest._id,
      });
      return;
    }

    const managerUser = await User.findById(property.landlord_id)
      .select('firstName lastName email')
      .lean();

    if (!managerUser?.email) {
      logger.error('Manager email not found:', { landlordId: property.landlord_id });
      return;
    }

    if (creatorId && String(managerUser._id) === String(creatorId)) {
      logger.info('Skipping manager duplicate - creator already notified', {
        maintenanceId: maintenanceRequest._id,
        userId: creatorId,
      });
      return;
    }

    if (wasAlreadyEmailed(alreadyEmailedEmails, managerUser.email)) {
      logger.info('Skipping manager duplicate - email already notified', {
        maintenanceId: maintenanceRequest._id,
        email: managerUser.email,
      });
      return;
    }

    const isSelfSubmitted = maintenanceRequest.isSelfCreated ?? (
      creatorId != null
      && rbIdList.some((id) => String(id) === String(creatorId))
    );

    const hoaPortal = process.env.HOA_PORTAL_URL || process.env.APP_URL || 'https://app.propmv.com';
    const landlordPortal = process.env.LANDLORD_PORTAL_URL || process.env.APP_URL || 'https://app.propmv.com';
    const tenantPortal = process.env.TENANT_PORTAL_URL || process.env.APP_URL || 'https://app.propmv.com';

    const baseUrls = {
      dashboardUrl:
        options.dashboardUrl ||
        (isHoaFlow ? `${hoaPortal}/maintenance` : `${landlordPortal}/maintenance/dashboard`),
      tenantPortalUrl: options.tenantPortalUrl || `${tenantPortal}/maintenance`,
      settingsUrl: options.settingsUrl || `${process.env.APP_URL || hoaPortal}/settings/notifications`,
      supportUrl: options.supportUrl || `${process.env.APP_URL || hoaPortal}/support`,
      privacyUrl: options.privacyUrl || `${process.env.APP_URL || hoaPortal}/privacy-policy`,
      currentYear: currentYearInAppTimezone(),
    };

    let tenantName = '-';
    const leaseQuery = {
      property_id: maintenanceRequest.property_id,
      status: 'Active',
    };
    let lease = null;

    if (maintenanceRequest.unitId) {
      lease = await Lease.findOne({ ...leaseQuery, unitId: maintenanceRequest.unitId })
        .select('rentAndDepositDestribution')
        .lean();
    }
    if (!lease && displayUnitName) {
      lease = await Lease.findOne({ ...leaseQuery, unitName: displayUnitName })
        .select('rentAndDepositDestribution')
        .lean();
    }

    if (lease?.rentAndDepositDestribution?.split?.length > 0) {
      const firstTenant = lease.rentAndDepositDestribution.split[0];
      const tenant = await User.findById(firstTenant.tenantId).select('firstName lastName').lean();
      if (tenant) {
        tenantName = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Tenant';
      }
    }

    const managerContent = buildManagerEmailContent({
      submitterRoleKey,
      submitterRoleLabel,
      requestedByName: requestedForDisplay,
      createdByDisplay,
      requestedForDisplay,
      isSelfSubmitted,
      recipientName: `${managerUser.firstName || ''} ${managerUser.lastName || ''}`.trim() || 'there',
      propertyName: property.name,
      unitName: displayUnitName,
      requestTitle: maintenanceRequest.title,
      isHoaFlow,
      notifyTenant: maintenanceRequest.notifyTenant,
    });

    const emailData = {
      ticketNumber: resolveMaintenanceTicketNumber(maintenanceRequest),
      requestTitle: maintenanceRequest.title,
      issue: formatCategory(maintenanceRequest),
      description: maintenanceRequest.description || '',
      category: formatCategory(maintenanceRequest),
      priority: formatMaintenancePriorityLabel(maintenanceRequest.priority || 'Medium'),
      isUrgent: Boolean(maintenanceRequest.isUrgent),
      status: formatMaintenanceStatusLabel(maintenanceRequest.status || 'Open'),
      propertyName: property.name,
      unitName: displayUnitName || '-',
      tenantName,
      requestedByName: requestedForDisplay,
      createdByDisplay,
      requestedForDisplay,
      createdAt: formatRequestDate(maintenanceRequest.request_date),
      notifyTenant: maintenanceRequest.notifyTenant,
      landlordName: `${managerUser.firstName || ''} ${managerUser.lastName || ''}`.trim(),
      ...managerContent,
      ...baseUrls,
    };

    logger.info('Sending maintenance manager notification', {
      recipientEmail: managerUser.email,
      submitterRoleKey,
      isHoaFlow,
      subject: managerContent.emailSubject,
    });

    try {
      await emailHelper.sendEmail('maintenance-request-created-landlord', managerUser.email, emailData, {
        subject: isHoaFlow
          ? buildCommunityEmailSubject(managerContent.emailSubject, communityName)
          : managerContent.emailSubject,
        hoaId: isHoaFlow ? (property?.hoaId || maintenanceRequest.hoaId) : null,
        senderUserId: creatorId || null,
        communityName: communityName || null,
      });
      trackEmailedRecipient(alreadyEmailedEmails, managerUser.email);
      logger.info('✓ Manager notification sent', { email: managerUser.email });
    } catch (err) {
      logger.error('Failed to send manager notification:', err);
    }

    // Tenant/resident emails only when notifyTenant is enabled AND specific tenants were selected.
    if (maintenanceRequest.notifyTenant) {
      const requestedByIds = normalizeRequestedByUserIds(maintenanceRequest.requestedBy).map(String);
      const leaseTenantIds = (lease?.rentAndDepositDestribution?.split || [])
        .map((split) => split.tenantId)
        .filter(Boolean)
        .map(String);

      const tenantIdsToNotify = requestedByIds.length
        ? requestedByIds.filter((id) => leaseTenantIds.includes(id))
        : leaseTenantIds;

      logger.info('Evaluating tenant maintenance notifications', {
        maintenanceId: maintenanceRequest._id,
        notifyTenant: true,
        requestedByCount: requestedByIds.length,
        leaseTenantCount: leaseTenantIds.length,
        selectedTenantCount: tenantIdsToNotify.length,
      });

      if (tenantIdsToNotify.length > 0) {
        const tenants = await User.find({ _id: { $in: tenantIdsToNotify } })
          .select('email firstName lastName')
          .lean();
        const tenantContent = buildTenantEmailContent({
          isHoaFlow,
          requestedByName,
          submitterRoleLabel,
        });

        for (const tenant of tenants) {
          if (!tenant?.email) continue;
          try {
            await emailHelper.sendEmail(
              'maintenance-request-created-tenant',
              tenant.email,
              {
                ...emailData,
                ...tenantContent,
                tenantName: `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Resident',
              },
              { subject: isHoaFlow
                ? buildCommunityEmailSubject(tenantContent.emailSubject, communityName)
                : tenantContent.emailSubject,
                hoaId: isHoaFlow ? (property?.hoaId || maintenanceRequest.hoaId) : null,
                senderUserId: creatorId || null,
                communityName: communityName || null,
              }
            );
            trackEmailedRecipient(alreadyEmailedEmails, tenant.email);
            logger.info('✓ Selected tenant notification sent', { email: tenant.email });
          } catch (err) {
            logger.error('Failed to send tenant notification:', { email: tenant.email, error: err.message });
          }
        }
      } else {
        logger.info('Skipping tenant notifications - notifyTenant enabled but no matching selected tenants', {
          maintenanceId: maintenanceRequest._id,
        });
      }
    } else {
      logger.info('Skipping tenant notifications - notifyTenant disabled', {
        maintenanceId: maintenanceRequest._id,
      });
    }

    // In-app notifications queued off the request path (excludes actor).
    notifyMaintenanceCreatedInAppInBackground(maintenanceRequest, creatorId, {
      unitName: displayUnitName,
    });
    logger.info('✓ Maintenance in-app notifications queued', {
      maintenanceId: maintenanceRequest._id,
    });

    logger.info('Maintenance request emails completed', { maintenanceId: maintenanceRequest._id });
  } catch (err) {
    logger.error('Error in sendMaintenanceRequestCreatedEmail:', err);
  }
}

/**
 * Resolve every associated user for comment / note / document activity emails:
 * board + property owners + assignee + requestedBy (Notify Requester gated).
 * Actor is intentionally kept so the person who acted also receives the email.
 */
async function resolveMaintenanceActivityRecipientIds(maintenanceRequest) {
  const ids = new Set();
  const property = await resolveMaintenancePropertyForEmail(maintenanceRequest);
  const hoaId = maintenanceRequest?.hoaId || property?.hoaId || null;

  if (hoaId) {
    const boardIds = await loadHoaMemberUserIds(hoaId);
    boardIds.forEach((id) => {
      const normalized = normalizeUserId(id);
      if (normalized) ids.add(normalized);
    });
  }

  if (property?._id) {
    try {
      const { resolvePropertyOwnerUserIds } = require('./hoaRecipientResolver');
      const ownerIds = await resolvePropertyOwnerUserIds(property._id);
      ownerIds.forEach((id) => {
        const normalized = normalizeUserId(id);
        if (normalized) ids.add(normalized);
      });
    } catch (err) {
      logger.warn('resolveMaintenanceActivityRecipientIds owner lookup failed', {
        maintenanceId: maintenanceRequest?._id,
        error: err.message,
      });
    }
  }

  normalizeRequestedByUserIds(maintenanceRequest?.requestedBy).forEach((id) => ids.add(id));
  const assigneeId = normalizeUserId(
    maintenanceRequest?.assignedTo && maintenanceRequest.assignedTo._id
      ? maintenanceRequest.assignedTo._id
      : maintenanceRequest?.assignedTo
  );
  if (assigneeId) ids.add(assigneeId);

  return {
    recipientIds: filterMaintenanceNotifyUserIds(maintenanceRequest, [...ids]),
    hoaId,
    property,
  };
}

const ACTIVITY_SUBJECT_PREFIX = {
  maintenance_comment_added: 'Maintenance comment',
  maintenance_note_added: 'Maintenance note',
  maintenance_documents_updated: 'Maintenance documents',
  maintenance_updated: 'Maintenance update',
  maintenance_reopened: 'Maintenance reopened',
};

/**
 * Send comment / note / document emails to all associated ticket users.
 * Uses the same transactional delivery path as create/assign emails.
 */
async function sendMaintenanceActivityEmails(maintenanceRequest, {
  eventKey = 'maintenance_updated',
  eventMessage = 'A maintenance request was updated.',
  dedupeKey = null,
  actorUserId = null,
} = {}) {
  if (!maintenanceRequest?._id) {
    return { attempted: 0, sent: 0, failed: 0 };
  }

  try {
    const { recipientIds, hoaId, property } = await resolveMaintenanceActivityRecipientIds(
      maintenanceRequest
    );

    if (!recipientIds.length) {
      logger.warn('sendMaintenanceActivityEmails skipped - no recipients', {
        maintenanceId: String(maintenanceRequest._id),
        eventKey,
        hoaId: hoaId ? String(hoaId) : null,
        actorUserId: actorUserId ? String(actorUserId) : null,
      });
      return { attempted: 0, sent: 0, failed: 0 };
    }

    const users = await loadMaintenancePartyUsers(recipientIds);
    const withEmail = users.filter((u) => u?.email);
    if (!withEmail.length) {
      logger.warn('sendMaintenanceActivityEmails skipped - recipients have no email', {
        maintenanceId: String(maintenanceRequest._id),
        recipientCount: recipientIds.length,
        eventKey,
      });
      return { attempted: 0, sent: 0, failed: 0 };
    }

    const isHoaFlow = Boolean(hoaId);
    const communityName = isHoaFlow && hoaId ? await resolveCommunityName(hoaId) : '';
    const propertyName = property?.name
      || maintenanceRequest.propertyName
      || 'N/A';
    const unitName = property
      ? unitDisplayNameFromMaintenance(property, maintenanceRequest)
      : maintenanceRequest.units || maintenanceRequest.unitName || '';
    const ticketNumber = resolveMaintenanceTicketNumber(maintenanceRequest);
    const ticketTitle = maintenanceRequest.title || 'Maintenance request';
    const ticketId = String(maintenanceRequest._id);
    const subjectPrefix = ACTIVITY_SUBJECT_PREFIX[eventKey] || 'Maintenance update';
    const baseSubject = `${ticketNumber || ticketTitle} - ${subjectPrefix}: ${ticketTitle}`;
    const subject = isHoaFlow
      ? buildCommunityEmailSubject(baseSubject, communityName)
      : baseSubject;
    const activityStamp = dedupeKey || `${eventKey}:${Date.now()}`;

    let sent = 0;
    let failed = 0;
    for (const user of withEmail) {
      const recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
      try {
        const result = await sendTransactionalEmail({
          eventKey: buildEventKey(
            'maintenance_activity_email',
            eventKey,
            ticketId,
            user.email,
            activityStamp
          ),
          type: 'maintenance-ticket-updated',
          toEmail: user.email,
          data: {
            recipientName,
            eventMessage,
            ticketId,
            ticketNumber,
            ticketTitle,
            ticketStatus: formatMaintenanceStatusLabel(maintenanceRequest.status || 'Open'),
            propertyName,
            unitName,
            viewTicketUrl: buildMaintenanceViewTicketUrl(maintenanceRequest, isHoaFlow),
            resolvedAt: formatEmailDateTime(ClockService.now()),
            communityName: communityName || '',
          },
          options: {
            template: 'maintenance-ticket-updated',
            subject,
            preheaderText: buildMaintenanceTicketPreheader({
              eventMessage,
              ticketTitle,
            }),
            hoaId: isHoaFlow ? hoaId : null,
            communityName: communityName || null,
          },
          entityType: 'Maintenance Request',
          entityId: ticketId,
          metadata: { eventKey, activityStamp },
          skipDuplicateCheck: false,
        });
        if (result?.sent) sent += 1;
        else {
          logger.info('sendMaintenanceActivityEmails result not sent', {
            email: user.email,
            reason: result?.reason || 'unknown',
            eventKey,
            maintenanceId: ticketId,
          });
        }
      } catch (err) {
        failed += 1;
        logger.error('sendMaintenanceActivityEmails send failed', {
          email: user.email,
          eventKey,
          maintenanceId: ticketId,
          error: err.message,
        });
      }
    }

    logger.info('sendMaintenanceActivityEmails finished', {
      maintenanceId: ticketId,
      eventKey,
      attempted: withEmail.length,
      sent,
      failed,
      recipientIds,
    });
    return { attempted: withEmail.length, sent, failed };
  } catch (err) {
    logger.error('sendMaintenanceActivityEmails failed', {
      maintenanceId: maintenanceRequest?._id,
      eventKey,
      error: err.message,
    });
    return { attempted: 0, sent: 0, failed: 1 };
  }
}

module.exports = {
  sendMaintenanceRequestCreatedEmail,
  notifyMaintenanceCreatedPartyEmails,
  sendMaintenanceVendorAssignedEmail,
  sendMaintenanceActivityEmails,
  buildMaintenanceViewTicketUrl,
  resolveMaintenancePropertyForEmail,
};
