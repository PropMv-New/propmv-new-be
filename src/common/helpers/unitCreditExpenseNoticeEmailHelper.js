/**
 * ------------------------------------------------------------------
 * File: unitCreditExpenseNoticeEmailHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for unitCreditExpenseNoticeEmailHelper.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const emailHelper = require('./emailHelper');
const User = require('../../shared/modules/users/models/user.model');
const logger = require('../logger');
const { loadHoaMemberUserIds } = require('../../middleware/hoaDataIsolation');

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
  const parts = [street, address.line2, address.city, address.state, address.zip].filter(Boolean);
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
 * When the last owner is removed and the unit still has unapplied credit (remainingCredit),
 * notify the removed owner and active HOA board members that a future "Start Fresh" assignment
 * will record an expense for that credit amount.
 */
async function sendCreditExpensePendingNotices({
  property,
  removedOwnerId,
  creditAmount,
  performedByName,
}) {
  if (!property || !removedOwnerId || !creditAmount || creditAmount <= 0) return;

  const dashboardUrl =
    process.env.APP_DASHBOARD_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.INVITE_BASE_URL ||
    'https://www.google.com';

  const unitName = getUnitName(property);
  const propertyName = property.name || 'Property';
  const unitAddress = formatUnitAddress(property.address || {});
  const amountStr = Number(creditAmount).toFixed(2);
  const boardName = performedByName || process.env.APP_NAME || 'PropMv';

  const owner = await User.findById(removedOwnerId).lean();
  const ownerEmail = owner?.email;
  const ownerFirst = owner?.firstName || owner?.lastName || 'there';

  const baseData = {
    propertyName,
    unitName,
    unitAddress,
    creditAmount: amountStr,
    dashboardUrl,
    performedByName: boardName,
  };

  const sendSafe = async (toEmail, recipientLabel, introParagraph) => {
    if (!toEmail || !String(toEmail).includes('@')) return;
    try {
      await emailHelper.sendEmail('unit-credit-expense-notice', toEmail, {
        ...baseData,
        recipientName: recipientLabel,
        introParagraph,
      }, {
        template: 'unit-credit-expense-notice',
        subject: `Unapplied unit credit ($${amountStr}) - expense will apply on next Start Fresh assignment`,
        preheaderText: introParagraph,
      });
    } catch (e) {
      logger.warn('[Email] unit-credit-expense-notice failed for', toEmail, e.message);
    }
  };

  if (ownerEmail) {
    await sendSafe(
      ownerEmail,
      ownerFirst,
      `You were removed as the last owner of this unit. The unit still has $${amountStr} in unapplied credit. When a new owner is assigned with Start Fresh, an HOA expense will be created for that amount.`
    );
  }

  let memberIds = [];
  if (property.hoaId) {
    memberIds = await loadHoaMemberUserIds(property.hoaId);
  }
  if (!memberIds.length && property.landlord_id) {
    memberIds = [String(property.landlord_id)];
  }

  const uniqueIds = [...new Set(memberIds.map((id) => String(id)).filter(Boolean))];
  if (!uniqueIds.length) return;

  const boardUsers = await User.find({
    _id: { $in: uniqueIds },
    isDeleted: { $ne: true },
  })
    .select('email firstName lastName')
    .lean();

  const ownerEmailLower = ownerEmail ? String(ownerEmail).toLowerCase() : '';

  for (const bu of boardUsers) {
    if (!bu.email) continue;
    if (ownerEmailLower && String(bu.email).toLowerCase() === ownerEmailLower) continue;
    const label = [bu.firstName, bu.lastName].filter(Boolean).join(' ') || 'Board member';
    await sendSafe(
      bu.email,
      label,
      `The last owner was removed from the unit below while $${amountStr} in unapplied credit remains. When a new owner is assigned with Start Fresh, an HOA expense will be created for that amount.`
    );
  }
}

module.exports = {
  sendCreditExpensePendingNotices,
};
