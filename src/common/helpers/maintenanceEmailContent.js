/**
 * ------------------------------------------------------------------
 * File: maintenanceEmailContent.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for maintenanceEmailContent.
 *
 * Used By:
 * maintenanceEmailHelper
 * ------------------------------------------------------------------
 */

/**
 * Role-aware copy and metadata for maintenance notification emails.
 */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * bold
 *
 * Performs logic operations for bold.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function bold(value) {
  return `<strong>${escapeHtml(value)}</strong>`;
}

/**
 * resolve User Role Name
 *
 * Performs logic operations for resolveUserRoleName.
 *
 * @param user - Request/input argument
 * @returns Operations result
 */
function resolveUserRoleName(user) {
  if (!user) return 'User';
  if (user.role && typeof user.role === 'object' && user.role.name) return user.role.name;
  return 'User';
}

/**
 * role Key From Name
 *
 * Performs logic operations for roleKeyFromName.
 *
 * @param roleName - Request/input argument
 * @returns Operations result
 */
function roleKeyFromName(roleName) {
  const n = String(roleName || '').toLowerCase();
  if (n.includes('hoa owner')) return 'hoa_owner';
  if (n.includes('hoa board')) return 'hoa_board';
  if (n.includes('property manager')) return 'property_manager';
  if (n.includes('tenant')) return 'tenant';
  if (n.includes('landlord')) return 'landlord';
  return 'generic';
}

const SUBMITTER_LABELS = {
  hoa_owner: 'HOA Owner',
  hoa_board: 'HOA Board Member',
  property_manager: 'Property Manager',
  tenant: 'Tenant',
  landlord: 'Landlord',
  generic: 'User',
};

/**
 * format Category
 *
 * Performs logic operations for formatCategory.
 *
 * @param maintenanceRequest - Request/input argument
 * @returns Operations result
 */
function formatCategory(maintenanceRequest) {
  if (maintenanceRequest.category) return maintenanceRequest.category;
  const parts = [maintenanceRequest.primaryRequestType, maintenanceRequest.subRequestType].filter(Boolean);
  return parts.length > 0 ? parts.join(' › ') : 'General';
}

/**
 * build Action Steps
 *
 * Performs logic operations for buildActionSteps.
 *
 * @param roleKey - Request/input argument
 * @param isHoaFlow - Request/input argument
 * @returns Operations result
 */
function buildActionSteps(roleKey, isHoaFlow) {
  if (isHoaFlow) {
    return [
      { text: 'Review the request details and priority level' },
      { text: 'Coordinate with vendors or your maintenance team' },
      { text: 'Update the ticket status as work progresses' },
      { text: 'Notify the owner or residents if access is required' },
    ];
  }
  if (roleKey === 'property_manager') {
    return [
      { text: 'Review the maintenance details and assign ownership' },
      { text: 'Schedule the vendor or internal maintenance team' },
      { text: 'Update status and keep the landlord informed' },
      { text: 'Track costs and document completion' },
    ];
  }
  return [
    { text: 'Review the maintenance details above' },
    { text: 'Assign the request to a contractor or team member' },
    { text: 'Update the status as work progresses' },
    { text: 'Track any associated costs and completion notes' },
  ];
}

/**
 * @param {Object} params
 * @param {string} params.submitterRoleKey
 * @param {string} params.submitterRoleLabel
 * @param {string} params.requestedByName
 * @param {boolean} params.isSelfSubmitted
 * @param {string} params.recipientName
 * @param {string} params.propertyName
 * @param {string} params.unitName
 * @param {string} params.requestTitle
 * @param {boolean} params.isHoaFlow
 * @param {boolean} params.notifyTenant
 */
function buildManagerEmailContent({
  submitterRoleKey,
  submitterRoleLabel,
  requestedByName,
  createdByDisplay = null,
  requestedForDisplay = null,
  isSelfSubmitted,
  recipientName,
  propertyName,
  unitName,
  requestTitle,
  isHoaFlow,
  notifyTenant,
}) {
  const location = unitName
    ? `${bold(unitName)} · ${bold(propertyName)}`
    : bold(propertyName);
  const safeRequester = bold(requestedByName);
  const safeRole = escapeHtml(submitterRoleLabel);
  const safeCreator = createdByDisplay ? bold(createdByDisplay) : safeRequester;
  const safeRequestedFor = requestedForDisplay ? bold(requestedForDisplay) : safeRequester;
  const onBehalfIntro = !isSelfSubmitted && createdByDisplay && requestedForDisplay
    ? `${safeCreator} created a maintenance request on behalf of ${safeRequestedFor} for ${location}. Please review the details and take appropriate action.`
    : null;

  let emailHeading = 'New Maintenance Request';
  let emailSubheading = 'A maintenance request needs your attention';
  let introParagraph;
  let footerBrandLine = isHoaFlow
    ? 'PropMv - HOA community management'
    : 'PropMv - Property management simplified';
  let dashboardCtaText = 'View request in dashboard';
  let emailSubject;

  const showTenantRow = !isHoaFlow;
  const showNotificationRow = !isHoaFlow;
  const notificationRowLabel = 'Tenant notification';
  const notifyTenantMessage = notifyTenant
    ? 'Tenants will be notified about this request'
    : 'Tenants will not be notified';
  const tenantRowLabel = 'Tenant';

  if (onBehalfIntro) {
    emailSubheading = 'A maintenance request was created on behalf of another party';
    introParagraph = onBehalfIntro;
    emailSubject = `Maintenance request: ${requestTitle}`;
  } else if (isHoaFlow) {
    emailHeading = 'New HOA Maintenance Request';
    dashboardCtaText = 'Open maintenance ticket';

    if (submitterRoleKey === 'hoa_owner') {
      emailSubheading = 'An HOA owner submitted a maintenance request';
      introParagraph = `${safeRequester} (${safeRole}) submitted a maintenance request for ${location}. Please review the details and coordinate follow-up with your board or vendors.`;
      emailSubject = `HOA owner maintenance request: ${requestTitle}`;
    } else if (submitterRoleKey === 'hoa_board') {
      if (isSelfSubmitted) {
        emailSubheading = 'You submitted a maintenance request for your community';
        introParagraph = `You submitted a maintenance request for ${location}. The details are below for your records - share with vendors or board members as needed.`;
        emailSubject = `Maintenance request submitted: ${requestTitle}`;
      } else {
        emailSubheading = 'A board member submitted a maintenance request';
        introParagraph = `${safeRequester} (${safeRole}) submitted a maintenance request for ${location}. Please review and assign follow-up.`;
        emailSubject = `HOA board maintenance request: ${requestTitle}`;
      }
    } else {
      emailSubheading = 'A maintenance request was submitted for your community';
      introParagraph = `${safeRequester} submitted a maintenance request for ${location}. Please review the details below.`;
      emailSubject = `HOA maintenance request: ${requestTitle}`;
    }
  } else if (submitterRoleKey === 'tenant') {
    emailHeading = 'New Tenant Maintenance Request';
    emailSubheading = 'A tenant submitted a maintenance request';
    introParagraph = `${safeRequester} (Tenant) submitted a maintenance request for ${location}. Please review and schedule follow-up.`;
    emailSubject = `Tenant maintenance request: ${requestTitle}`;
  } else if (submitterRoleKey === 'property_manager') {
    emailHeading = 'New Maintenance Request';
    emailSubheading = 'Your property manager logged a maintenance request';
    introParagraph = isSelfSubmitted
      ? `You submitted a maintenance request for ${location}. The details are captured below.`
      : `${safeRequester} (Property Manager) submitted a maintenance request for ${location}.`;
    emailSubject = `Maintenance request: ${requestTitle}`;
  } else if (submitterRoleKey === 'landlord') {
    if (isSelfSubmitted) {
      emailSubheading = 'You created a maintenance request';
      introParagraph = `You submitted a maintenance request for ${location}. The details are below for your records.`;
    } else {
      introParagraph = `${safeRequester} submitted a maintenance request for ${location}. Please review the details below and take appropriate action.`;
    }
    emailSubject = `Maintenance request: ${requestTitle}`;
  } else {
    introParagraph = `${safeRequester} submitted a maintenance request for ${location}. Please review the details below.`;
    emailSubject = `Maintenance request: ${requestTitle}`;
  }

  if (!introParagraph) {
    introParagraph = `A new maintenance request has been submitted for ${location}. Please review the details below.`;
  }
  if (!emailSubject) {
    emailSubject = `Maintenance request: ${requestTitle}`;
  }

  return {
    emailHeading,
    emailSubheading,
    introParagraph,
    recipientGreetingName: recipientName,
    submitterRoleLabel,
    submitterRoleBadge: submitterRoleLabel,
    requestedByLabel: createdByDisplay ? 'Requested for' : 'Submitted by',
    createdByLabel: 'Created by',
    showCreatedByRow: Boolean(createdByDisplay),
    showRequestedForRow: Boolean(requestedForDisplay),
    createdByDisplay,
    requestedForDisplay,
    showTenantRow,
    tenantRowLabel,
    showNotificationRow,
    notificationRowLabel,
    notifyTenantMessage,
    notifyBadgeClass: notifyTenant ? 'yes' : 'no',
    footerBrandLine,
    dashboardCtaText,
    emailSubject,
    actionSteps: buildActionSteps(submitterRoleKey, isHoaFlow),
    isHoaFlow,
    audiencePortal: isHoaFlow ? 'hoa' : 'rental',
  };
}

/**
 * Copy for tenant / resident notification emails.
 */
function buildTenantEmailContent({ isHoaFlow, requestedByName, submitterRoleLabel }) {
  if (isHoaFlow) {
    return {
      emailHeading: 'Maintenance Request Update',
      emailSubheading: 'A maintenance request was logged for your unit',
      introParagraph: `A maintenance request has been submitted for your unit by ${bold(requestedByName)} (${escapeHtml(submitterRoleLabel)}). Your HOA board or property team will coordinate any required access or repairs.`,
      infoBoxTitle: 'What you should know',
      infoBoxItems: [
        { text: 'Maintenance staff or a vendor may need access to your unit' },
        { text: 'Your HOA board will coordinate timing and updates' },
        { text: 'Track progress anytime in your owner portal' },
      ],
      closingParagraph: 'If you have questions, contact your HOA board or property management team.',
      portalCtaText: 'View in owner portal',
      emailSubject: 'Maintenance request for your unit',
    };
  }

  return {
    emailHeading: 'Maintenance Request',
    emailSubheading: 'A maintenance request was submitted for your unit',
    introParagraph: `A maintenance request has been created for your unit. ${bold(requestedByName)} (${escapeHtml(submitterRoleLabel)}) logged this request - your landlord or property manager will coordinate next steps.`,
    infoBoxTitle: 'What you need to know',
    infoBoxItems: [
      { text: 'A contractor or maintenance staff may need to access your unit' },
      { text: 'Your landlord or property manager will coordinate timing with you' },
      { text: 'You can track progress in your tenant portal' },
    ],
    closingParagraph: 'If you have any questions, contact your landlord or property manager directly.',
    portalCtaText: 'View in tenant portal',
    emailSubject: 'Maintenance request for your unit',
  };
}

module.exports = {
  resolveUserRoleName,
  roleKeyFromName,
  SUBMITTER_LABELS,
  formatCategory,
  buildManagerEmailContent,
  buildTenantEmailContent,
};
