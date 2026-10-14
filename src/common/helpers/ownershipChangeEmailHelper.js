const emailHelper = require('./emailHelper');
const User = require('../../shared/modules/users/models/user.model');
const { formatDateInAppTimezone } = require('./hoaBillingDates');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('./communityEmailContext.service');
const logger = require('../logger');

function formatUnitAddress(address = {}) {
  const street = address.street || address.line1 || '';
  const parts = [street, address.line2, address.city, address.state, address.zip || address.zipCode].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Address not available';
}

function getUnitName(property = {}) {
  return property?.unitDetails?.[0]?.unitName || property?.name || 'Unit';
}

function getDashboardUrl() {
  return (
    process.env.HOA_FRONTEND_BASE_URL ||
    process.env.APP_DASHBOARD_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.INVITE_BASE_URL ||
    'https://app.propmv.com'
  );
}

function formatOwnerNames(users = []) {
  const names = users
    .map((u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || u?.email || '')
    .filter(Boolean);
  if (names.length === 0) return '-';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function buildSettlementNote(balanceResetSettlement) {
  if (!balanceResetSettlement) return '';
  const writtenOff = Number(balanceResetSettlement.invoicesWrittenOffTotal || 0);
  const creditExp = Number(balanceResetSettlement.creditReleasedExpense || 0);
  const parts = [];
  if (writtenOff > 0) parts.push(`Outstanding dues of $${writtenOff.toFixed(2)} were settled as part of this transfer.`);
  if (creditExp > 0) parts.push(`Unapplied credit of $${creditExp.toFixed(2)} was recorded as an HOA expense.`);
  return parts.join(' ');
}

async function loadOwnerUsers(ownerIds = []) {
  const ids = [...new Set((ownerIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  return User.find({
    _id: { $in: ids },
    isDeleted: { $ne: true },
  })
    .select('firstName lastName email')
    .lean();
}

async function sendOwnershipChangeEmail({
  template,
  subjectBase,
  preheaderText,
  recipient,
  property,
  performedByName,
  currentOwnerNames,
  futureOwnerNames,
  effectiveDateLabel,
  introParagraph,
  headline,
  hoaId,
}) {
  if (!recipient?.email || !String(recipient.email).includes('@')) return;

  const communityName = await resolveCommunityName(hoaId);
  const recipientName = recipient.firstName || recipient.lastName || 'there';

  await emailHelper.sendEmail(
    template,
    recipient.email,
    {
      recipientName,
      performedByName: performedByName || process.env.APP_NAME || 'PropMv',
      propertyName: property?.name || 'Property',
      unitName: getUnitName(property),
      unitAddress: formatUnitAddress(property?.address || {}),
      currentOwnerNames,
      futureOwnerNames,
      previousOwnerNames: currentOwnerNames,
      newOwnerNames: futureOwnerNames,
      effectiveDateLabel: effectiveDateLabel || '',
      introParagraph,
      headline,
      dashboardUrl: getDashboardUrl(),
      communityName: communityName || '',
    },
    {
      template,
      subject: buildCommunityEmailSubject(subjectBase, communityName),
      preheaderText,
      hoaId,
      communityName: communityName || null,
    }
  );
}

/**
 * Email each recipient their own copy of the scheduled ownership change notice.
 */
async function sendOwnershipChangeScheduledEmails({
  recipients = [],
  property,
  previousOwnerIds = [],
  newOwnerIds = [],
  effectiveDate,
  performedBy = null,
  balanceResetSettlement = null,
}) {
  const hoaId = property?.hoaId || null;
  const effectiveDateLabel = effectiveDate
    ? formatDateInAppTimezone(effectiveDate, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  let performedByName = process.env.APP_NAME || 'PropMv';
  if (performedBy) {
    const actor = await User.findById(performedBy).select('firstName lastName email').lean();
    if (actor) {
      performedByName =
        `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || actor.email || performedByName;
    }
  }

  const [previousOwners, newOwners] = await Promise.all([
    loadOwnerUsers(previousOwnerIds),
    loadOwnerUsers(newOwnerIds),
  ]);
  const currentOwnerNames = formatOwnerNames(previousOwners);
  const futureOwnerNames = formatOwnerNames(newOwners);
  const settlementNote = buildSettlementNote(balanceResetSettlement);

  const introParagraph = [
    `An ownership change has been scheduled for ${property?.name || 'this property'} (${getUnitName(property)}).`,
    `Owner ${currentOwnerNames} will remain the current owner until ${effectiveDateLabel || 'the effective transfer date'}.`,
    settlementNote,
  ].filter(Boolean).join(' ');

  const headline = 'Ownership change scheduled';
  const subjectBase = `Ownership change scheduled for ${getUnitName(property)}`;

  await Promise.all(
    recipients.map((recipient) =>
      sendOwnershipChangeEmail({
        template: 'ownership-change-scheduled',
        subjectBase,
        preheaderText: headline,
        recipient,
        property,
        performedByName,
        currentOwnerNames,
        futureOwnerNames,
        effectiveDateLabel,
        introParagraph,
        headline,
        hoaId,
      }).catch((err) => {
        logger.warn('[ownershipChangeEmail] scheduled send failed', {
          recipientId: recipient?._id,
          error: err?.message || err,
        });
      })
    )
  );
}

/**
 * Email each recipient when the ownership change becomes effective.
 */
async function sendOwnershipChangeEffectiveEmails({
  recipients = [],
  property,
  previousOwnerIds = [],
  newOwnerIds = [],
  effectiveDate,
  performedBy = null,
  balanceResetSettlement = null,
}) {
  const hoaId = property?.hoaId || null;
  const effectiveDateLabel = effectiveDate
    ? formatDateInAppTimezone(effectiveDate, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  let performedByName = process.env.APP_NAME || 'PropMv';
  if (performedBy) {
    const actor = await User.findById(performedBy).select('firstName lastName email').lean();
    if (actor) {
      performedByName =
        `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || actor.email || performedByName;
    }
  }

  const [previousOwners, newOwners] = await Promise.all([
    loadOwnerUsers(previousOwnerIds),
    loadOwnerUsers(newOwnerIds),
  ]);
  const currentOwnerNames = formatOwnerNames(previousOwners);
  const futureOwnerNames = formatOwnerNames(newOwners);
  const settlementNote = buildSettlementNote(balanceResetSettlement);

  const introParagraph = [
    `The ownership change for ${property?.name || 'this property'} (${getUnitName(property)}) is now effective.`,
    `Previous owner: ${currentOwnerNames}. New owner: ${futureOwnerNames}.`,
    settlementNote,
  ].filter(Boolean).join(' ');

  const headline = 'Ownership change is now effective';
  const subjectBase = `Ownership change is now effective for ${getUnitName(property)}`;

  await Promise.all(
    recipients.map((recipient) =>
      sendOwnershipChangeEmail({
        template: 'ownership-change-effective',
        subjectBase,
        preheaderText: headline,
        recipient,
        property,
        performedByName,
        currentOwnerNames,
        futureOwnerNames,
        effectiveDateLabel,
        introParagraph,
        headline,
        hoaId,
      }).catch((err) => {
        logger.warn('[ownershipChangeEmail] effective send failed', {
          recipientId: recipient?._id,
          error: err?.message || err,
        });
      })
    )
  );
}

module.exports = {
  sendOwnershipChangeScheduledEmails,
  sendOwnershipChangeEffectiveEmails,
  formatOwnerNames,
  buildSettlementNote,
};
