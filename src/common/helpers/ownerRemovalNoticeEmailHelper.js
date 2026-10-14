/**
 * ------------------------------------------------------------------
 * File: ownerRemovalNoticeEmailHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for ownerRemovalNoticeEmailHelper.
 *
 * Used By:
 * owner.service, unit.service
 * ------------------------------------------------------------------
 */

const emailHelper = require('./emailHelper');
const User = require('../../shared/modules/users/models/user.model');
const { formatDateInAppTimezone, compareCalendarDateToToday } = require('./hoaBillingDates');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('./communityEmailContext.service');

function isFutureOwnershipEffectiveDate(effectiveDate) {
  if (!effectiveDate) return false;
  return compareCalendarDateToToday(effectiveDate) > 0;
}

function buildSettlementNote(balanceSettlement, { future = false } = {}) {
  if (balanceSettlement === 'WAIVE') {
    return future
      ? ' When the removal takes effect, any outstanding balance on the unit will be waived.'
      : ' Any outstanding balance on the unit was waived as part of this removal.';
  }
  if (balanceSettlement === 'MARK_PAID') {
    return future
      ? ' When the removal takes effect, outstanding dues on the unit will be settled.'
      : ' Outstanding dues on the unit were settled as part of this removal.';
  }
  if (balanceSettlement === 'KEEP_AS_IS') {
    return future
      ? ' Outstanding balances on the unit will remain unchanged when the removal takes effect.'
      : ' Outstanding balances on the unit were left unchanged.';
  }
  return '';
}

/**
 * format Unit Address
 *
 * Performs logic operations for formatUnitAddress.
 *
 * @param address - Request/input argument
 * @returns Operations result
 */
function formatUnitAddress(address = {}) {
  const street = address.street || address.line1 || '';
  const parts = [street, address.line2, address.city, address.state, address.zip || address.zipCode].filter(Boolean);
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
  return property?.unitDetails?.[0]?.unitName || property?.name || 'Unit';
}

/**
 * build Removal Copy
 *
 * Performs logic operations for buildRemovalCopy.
 *
 * @param options - Request/input argument
 * @param balanceSettlement - Request/input argument
 * @returns Operations result
 */
function buildRemovalCopy({ action, balanceSettlement, effectiveDate }) {
  if (action === 'delete') {
    return {
      headline: 'Your owner account has been removed',
      introParagraph:
        'Your HOA owner account has been deleted by the board. You will no longer have portal access for the associated unit(s). Historical invoices and payment records remain on file for the association.',
      subject: 'Your HOA owner account has been removed',
    };
  }

  const effectiveLabel = effectiveDate
    ? formatDateInAppTimezone(effectiveDate)
    : null;
  const isScheduled = isFutureOwnershipEffectiveDate(effectiveDate);
  const settlementNote = buildSettlementNote(balanceSettlement, { future: isScheduled });

  if (isScheduled) {
    return {
      headline: 'Your ownership is scheduled to end for a unit',
      introParagraph: `Your ownership period for the unit below is scheduled to end${effectiveLabel ? ` effective ${effectiveLabel}` : ''}.${settlementNote} You will remain the owner of record until that date and can continue using the owner portal until then.`,
      effectiveDateLabel: effectiveLabel,
      subject: 'Your unit ownership is scheduled to end',
    };
  }

  return {
    headline: 'Your ownership has ended for a unit',
    introParagraph: `Your ownership period for the unit below has ended${effectiveLabel ? ` effective ${effectiveLabel}` : ''}.${settlementNote} You may still access historical invoices and records in your owner portal when applicable.`,
    effectiveDateLabel: effectiveLabel,
    subject: 'Your unit ownership has ended',
  };
}

/**
 * Notify the HOA owner when they are removed from a unit or their account is deleted.
 */
async function sendOwnerRemovalNoticeEmail({
  owner,
  property,
  action = 'remove',
  effectiveDate = null,
  balanceSettlement = null,
  performedBy = null,
}) {
  if (!owner?.email || !String(owner.email).includes('@')) return;

  const dashboardUrl =
    process.env.APP_DASHBOARD_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.INVITE_BASE_URL ||
    'https://www.google.com';

  let performedByName = process.env.APP_NAME || 'PropMv';
  if (performedBy) {
    const actor = await User.findById(performedBy).select('firstName lastName email').lean();
    if (actor) {
      performedByName =
        `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || actor.email || performedByName;
    }
  }

  const copy = buildRemovalCopy({ action, balanceSettlement, effectiveDate });
  const recipientName = owner.firstName || owner.lastName || 'there';
  const hoaId = property?.hoaId || null;
  const communityName = await resolveCommunityName(hoaId);
  const baseSubject = copy.subject
    || (action === 'delete'
      ? 'Your HOA owner account has been removed'
      : 'Your unit ownership has ended');

  await emailHelper.sendEmail(
    'owner-removal-notice',
    owner.email,
    {
      recipientName,
      performedByName,
      propertyName: property?.name || 'Property',
      unitName: getUnitName(property),
      unitAddress: formatUnitAddress(property?.address || {}),
      headline: copy.headline,
      introParagraph: copy.introParagraph,
      effectiveDateLabel: copy.effectiveDateLabel || '',
      dashboardUrl,
      communityName: communityName || '',
    },
    {
      template: 'owner-removal-notice',
      subject: buildCommunityEmailSubject(baseSubject, communityName),
      preheaderText: copy.headline,
      hoaId,
      communityName: communityName || null,
    }
  );
}

module.exports = {
  sendOwnerRemovalNoticeEmail,
  buildRemovalCopy,
  isFutureOwnershipEffectiveDate,
};
