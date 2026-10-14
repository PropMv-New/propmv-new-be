/**
 * ------------------------------------------------------------------
 * File: unitAssignmentEmailHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for unitAssignmentEmailHelper.
 *
 * Used By:
 * owner.service, unit.service
 * ------------------------------------------------------------------
 */

const emailHelper = require('./emailHelper');
const { formatDateInAppTimezone } = require('./hoaBillingDates');
const { buildUnitAssignmentPreheader } = require('./emailDisplayHelper');
const { ClockService } = require('../date');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('./communityEmailContext.service');

/**
 * format Unit Address
 *
 * Performs logic operations for formatUnitAddress.
 *
 * @param address - Request/input argument
 * @returns Operations result
 */
function formatUnitAddress(address = {}) {
  const parts = [address.street, address.line2, address.city, address.state, address.zip].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Address not available';
}

/**
 * get Unit Name
 *
 * Performs logic operations for getUnitName.
 *
 * @param property - Request/input argument
 * @returns Operations result
 */
function getUnitName(property = {}) {
  return property?.unitDetails?.[0]?.unitName || property?.name || 'Assigned Unit';
}

function resolveAssignmentHoaId({ property, recipient, hoaId }) {
  return (
    hoaId ||
    property?.hoaId ||
    recipient?.hoaInfo?.hoaId ||
    null
  );
}

async function sendUnitAssignmentEmail({
  recipient,
  property,
  assignedByName,
  skipRecipientValidation = false,
  hoaId = null,
  communityName = null,
}) {
  if (!recipient?.email || !property) return;

  const dashboardUrl =
    process.env.APP_DASHBOARD_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.INVITE_BASE_URL ||
    'https://www.google.com';

  const resolvedHoaId = resolveAssignmentHoaId({ property, recipient, hoaId });
  const resolvedCommunityName =
    communityName ||
    (await resolveCommunityName(
      resolvedHoaId,
      property?.communityName ||
        property?.hoaName ||
        recipient?.hoaInfo?.communityName ||
        ''
    ));

  const data = {
    recipientName: recipient.firstName || recipient.lastName || 'there',
    assignedByName: assignedByName || process.env.APP_NAME || 'PropMv Team',
    unitName: getUnitName(property),
    propertyName: property.name || 'Property',
    unitAddress: formatUnitAddress(property.address),
    assignedOn: formatDateInAppTimezone(ClockService.now()),
    dashboardUrl,
    communityName: resolvedCommunityName || '',
    organizationDisplayName: resolvedCommunityName || '',
  };

  await emailHelper.sendEmail('unit-assignment', recipient.email, data, {
    template: 'unit-assignment',
    subject: buildCommunityEmailSubject('Unit assigned to your account', resolvedCommunityName),
    preheaderText: buildUnitAssignmentPreheader({
      unitName: data.unitName,
      propertyName: data.propertyName,
    }),
    hoaId: resolvedHoaId,
    communityName: resolvedCommunityName || null,
    skipRecipientValidation: Boolean(skipRecipientValidation),
  });
}

module.exports = {
  sendUnitAssignmentEmail,
  resolveAssignmentHoaId,
};
