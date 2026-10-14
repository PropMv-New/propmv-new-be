/**
 * ------------------------------------------------------------------
 * File: leaseTenantInviteDelivery.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * test-lease-onboarding-emails, application.service, tenant.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const logger = require('../../../../../common/logger');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}
const Lease = require('../model/lease.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const portalInvitationService = require('../../../../../shared/modules/auth/services/portalInvitation.service');
const { resolveCreatedBy } = require('../../../../../shared/utils/creatorScope.util');
const { recordLeaseTenantInviteSent } = require('./leaseTenantInviteAck.service');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
const { buildScreeningApplicationPreheader } = require('../../../../../common/helpers/emailDisplayHelper');

const ONBOARDING_EMAIL_STAGGER_MS = Number(process.env.LEASE_ONBOARDING_EMAIL_STAGGER_MS || 600);

/**
 * delay
 *
 * Performs logic operations for delay.
 *
 * @param ms - Request/input argument
 * @returns Operations result
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * build Acknowledge Url
 *
 * Performs logic operations for buildAcknowledgeUrl.
 *
 * @param tenantId - Request/input argument
 * @param leaseId - Request/input argument
 * @returns Operations result
 */
function buildAcknowledgeUrl(tenantId, leaseId) {
  const acknowledgeBaseUrl =
    process.env.TENANT_ACKNOWLEDGE_BASE_URL ||
    `${(process.env.FRONTEND_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}/acknowledge`;
  return `${acknowledgeBaseUrl}/${tenantId}/lease/${leaseId}`;
}

/**
 * split Needs Application
 *
 * Performs logic operations for splitNeedsApplication.
 *
 * @param screening - Request/input argument
 * @returns Operations result
 */
function splitNeedsApplication(screening = []) {
  return Array.isArray(screening) && screening.includes('application');
}

/** True when any screening type is assigned (application, credit, or criminal). */
function hasTenantScreening(screening = []) {
  return Array.isArray(screening) && screening.length > 0;
}

/**
 * Prefer lease split screening; fall back to request payload / user profile.
 */
/**
 * Screening for lease email routing - lease split + request payload only (never user.profile.screening).
 */
function resolveTenantScreeningForEmail(splitEntry, requestScreening) {
  if (splitEntry && Object.prototype.hasOwnProperty.call(splitEntry, 'screening')) {
    return normalizeScreeningArray(splitEntry.screening);
  }
  if (Array.isArray(requestScreening)) {
    return normalizeScreeningArray(requestScreening);
  }
  return [];
}

/** @deprecated Use resolveTenantScreeningForEmail */
function resolveTenantScreening(splitEntry, ...fallbacks) {
  const requestScreening = fallbacks.find((fb) => Array.isArray(fb));
  return resolveTenantScreeningForEmail(splitEntry, requestScreening);
}

/**
 * resolve Split Entry For Tenant Email
 *
 * Performs logic operations for resolveSplitEntryForTenantEmail.
 *
 * @param leaseSplit - Request/input argument
 * @param tenantId - Request/input argument
 * @param index - Request/input argument
 * @param tenantKey - Request/input argument
 * @returns Operations result
 */
function resolveSplitEntryForTenantEmail(leaseSplit, tenantId, index, tenantKey) {
  return (
    findSplitEntryForTenant(leaseSplit, tenantId, index, tenantKey) ||
    (typeof index === 'number' && Array.isArray(leaseSplit) && leaseSplit[index] ? leaseSplit[index] : null)
  );
}

/**
 * normalize Split Tenant Id
 *
 * Performs logic operations for normalizeSplitTenantId.
 *
 * @param raw - Request/input argument
 * @returns Operations result
 */
function normalizeSplitTenantId(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'object') {
    if (raw._id != null) return String(raw._id);
    if (typeof raw.toString === 'function' && raw.constructor?.name === 'ObjectId') {
      return String(raw);
    }
  }
  return String(raw);
}

/**
 * find Split Entry For Tenant
 *
 * Performs logic operations for findSplitEntryForTenant.
 *
 * @param leaseSplit - Request/input argument
 * @param tenantId - Request/input argument
 * @param index - Request/input argument
 * @param tenantKey - Request/input argument
 * @returns Operations result
 */
function findSplitEntryForTenant(leaseSplit, tenantId, index, tenantKey = null) {
  const normalizedTenantId = normalizeSplitTenantId(tenantId);
  const byId = (leaseSplit || []).find(
    (s) => normalizeSplitTenantId(s?.tenantId) === normalizedTenantId
  );
  if (byId) return byId;
  if (tenantKey != null) {
    const byKey = (leaseSplit || []).find((s) => String(s?.key || '') === String(tenantKey));
    if (byKey) return byKey;
  }
  if (typeof index === 'number' && leaseSplit && leaseSplit[index]) return leaseSplit[index];
  return null;
}

/**
 * normalize Screening Array
 *
 * Performs logic operations for normalizeScreeningArray.
 *
 * @param screening - Request/input argument
 * @returns Operations result
 */
function normalizeScreeningArray(screening) {
  if (!Array.isArray(screening)) return [];
  return [...new Set(screening.map(String).filter(Boolean))];
}

/** Copy screening from tenant payload onto split rows (matched by key). */
function syncScreeningFromTenantsToSplit(tenantsData = [], split = []) {
  if (!Array.isArray(split) || split.length === 0) return split;
  return split.map((entry) => {
    const out = Object.assign({}, entry);
    const key = out.key != null ? String(out.key) : null;
    const match = key ? (tenantsData || []).find((t) => String(t.key) === key) : null;
    if (match && Object.prototype.hasOwnProperty.call(match, 'screening')) {
      out.screening = normalizeScreeningArray(match.screening);
    } else if (Array.isArray(out.screening)) {
      out.screening = normalizeScreeningArray(out.screening);
    } else {
      out.screening = [];
    }
    return out;
  });
}

/**
 * build Screening Checks Html
 *
 * Performs logic operations for buildScreeningChecksHtml.
 *
 * @param screening - Request/input argument
 * @returns Operations result
 */
function buildScreeningChecksHtml(screening = []) {
  const labels = {
    application: 'Application Form',
    credit: 'Credit Check',
    criminal: 'Criminal Background Check',
  };
  const descriptions = {
    application: 'Complete your rental application and references',
    credit: 'Authorize a credit history review',
    criminal: 'Authorize a criminal background check',
  };
  return normalizeScreeningArray(screening)
    .map(
      (type) =>
        `<div style="background:#fff7ed;border-left:4px solid #f97316;padding:12px 14px;margin:10px 0;border-radius:8px;font-size:14px;line-height:1.5"><strong style="color:#0f172a">${labels[type] || type}</strong><br/><span style="color:#64748b">${descriptions[type] || ''}</span></div>`
    )
    .join('');
}

async function resolveLandlordContext(propertyRef) {
  let landlordName = 'Your Landlord';
  let landlordEmail = 'noreply@propmv.com';
  let landlordUserId = null;

  const propertyOwnerId = resolveCreatedBy(propertyRef);
  if (propertyOwnerId) {
    landlordUserId = String(propertyOwnerId);
    const safeOwnerId = toObjectId(propertyOwnerId);
    const landlord = safeOwnerId ? await User.findOne({ _id: safeOwnerId, isDeleted: { $ne: true } }).lean() : null;
    if (landlord) {
      landlordName =
        `${landlord.firstName || ''} ${landlord.lastName || ''}`.trim() ||
        landlord.email ||
        'Your Landlord';
      landlordEmail = landlord.email || landlordEmail;
    }
  }

  return { landlordName, landlordEmail, landlordUserId };
}

/**
 * Send lease invite email to a tenant and record leasetenantinviteacks row (inviteSentAt).
 */
async function sendLeaseTenantInviteEmail({
  leaseId,
  tenantId,
  inviterUserId = null,
  session = null,
  /** When true, always send the lease invitation email (ack link + property details), not portal activation. */
  forceLeaseInviteEmail = false,
} = {}) {
  if (!leaseId || !tenantId) {
    const err = new Error('leaseId and tenantId are required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(leaseId)) || !mongoose.Types.ObjectId.isValid(String(tenantId))) {
    const err = new Error('leaseId and tenantId must be valid ObjectIds');
    err.status = 400;
    throw err;
  }

  const safeLeaseId = new mongoose.Types.ObjectId(String(leaseId));
  const safeTenantId = new mongoose.Types.ObjectId(String(tenantId));

  const lease = await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } })
    .populate('property_id', 'name address createdBy landlord_id')
    .lean();
  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }

  const split = Array.isArray(lease.rentAndDepositDestribution?.split)
    ? lease.rentAndDepositDestribution.split
    : [];
  const normalizedTenantId = normalizeSplitTenantId(tenantId);
  const onLease = split.some((s) => normalizeSplitTenantId(s?.tenantId) === normalizedTenantId);
  if (!onLease) {
    const err = new Error('Tenant is not on this lease');
    err.status = 403;
    throw err;
  }

  const tenant = await User.findOne({ _id: safeTenantId, isDeleted: { $ne: true } }).lean();
  if (!tenant || !tenant.email) {
    const err = new Error('Tenant not found or has no email');
    err.status = 404;
    throw err;
  }

  const splitEntry = split.find((s) => normalizeSplitTenantId(s?.tenantId) === normalizedTenantId);
  const rentShare = splitEntry || {};

  const { landlordName, landlordEmail, landlordUserId } = await resolveLandlordContext(lease.property_id);
  const propertyName = lease.property_id?.name || 'Property';
  const propertyAddress = lease.property_id?.address
    ? `${lease.property_id.address.street || ''}, ${lease.property_id.address.city || ''}, ${lease.property_id.address.state || ''} ${lease.property_id.address.zip || ''}`.trim()
    : 'N/A';

  const tenantName = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || tenant.email;
  const acknowledgeUrl = buildAcknowledgeUrl(tenantId, leaseId);

  const emailData = {
    tenantName,
    landlordName,
    appName: process.env.APP_NAME || 'propmv',
    inviteUrl: acknowledgeUrl,
    acknowledgeLink: acknowledgeUrl,
    acknowledgeBlock: '',
    propertyName,
    propertyAddress,
    unitName: lease.unitName || 'N/A',
    leaseStartDate: lease.start_date
      ? formatDateInAppTimezone(lease.start_date)
      : 'N/A',
    leaseEndDate: lease.end_date
      ? formatDateInAppTimezone(lease.end_date)
      : 'N/A',
    rentAmount: `$${rentShare.rentAmount || 0}`,
    dashboardUrl: (process.env.FRONTEND_BASE_URL || 'http://localhost:8080').replace(/\/$/, ''),
    currentYear: DateUtil.toEST(ClockService.now()).slice(0, 4),
  };

  const sendLegacyLeaseInviteEmail = async () => {
    const acknowledgeBlock =
      emailData.acknowledgeBlock ||
      `<p style="margin:18px 0 0;font-size:14px;line-height:1.55;color:#64748b">After you sign in, please <a href="${acknowledgeUrl}" style="color:#f97316;font-weight:600">acknowledge your lease invite</a> to continue.</p>`;
    const inviteSubject = `Action required: Lease invitation - ${propertyName}`;
    await emailHelper.sendEmail(
      'invite',
      tenant.email,
      {
        ...emailData,
        landlordName,
        appName: emailData.appName || process.env.APP_NAME || 'PropMv',
        inviteUrl: acknowledgeUrl,
        acknowledgeLink: acknowledgeUrl,
        acknowledgeBlock,
      },
      {
        template: 'invite',
        subject: inviteSubject,
        replyTo: landlordEmail,
      }
    );
    logger.info(
      `[LeaseInvite] Delivered lease invite to ${tenant.email} (tenant ${tenantId}, lease ${leaseId})`
    );
  };

  let sentVia = 'legacy';
  const canUsePortalInvite =
    !forceLeaseInviteEmail && inviterUserId && mongoose.Types.ObjectId.isValid(String(inviterUserId));

  if (canUsePortalInvite) {
    try {
      await portalInvitationService.issueLandlordTenantPortalInvite({
        inviteeUserId: String(tenantId),
        inviterUserId: String(inviterUserId),
        landlordDisplayName: landlordName,
        acknowledgeUrl,
      });
      sentVia = 'portal';
    } catch (portalErr) {
      logger.warn(
        `[LeaseInvite] Portal invite failed for ${tenant.email}, falling back to lease invite email:`,
        portalErr.message
      );
      await sendLegacyLeaseInviteEmail();
      sentVia = 'legacy';
    }
  } else {
    await sendLegacyLeaseInviteEmail();
  }

  await recordLeaseTenantInviteSent(leaseId, tenantId, { session });

  return {
    sent: true,
    leaseId: String(leaseId),
    tenantId: String(tenantId),
    email: tenant.email,
    acknowledgeUrl,
    sentVia,
  };
}

/**
 * Send screening application email for a tenant on a lease.
 */
async function sendTenantScreeningApplicationEmail({ leaseId, tenantId, screening = [] } = {}) {
  if (!leaseId || !tenantId) {
    const err = new Error('leaseId and tenantId are required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(leaseId)) || !mongoose.Types.ObjectId.isValid(String(tenantId))) {
    const err = new Error('leaseId and tenantId must be valid ObjectIds');
    err.status = 400;
    throw err;
  }

  const safeLeaseId = new mongoose.Types.ObjectId(String(leaseId));
  const safeTenantId = new mongoose.Types.ObjectId(String(tenantId));

  const [lease, tenant] = await Promise.all([
    Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } })
      .populate('property_id', 'name createdBy landlord_id')
      .lean(),
    User.findOne({ _id: safeTenantId, isDeleted: { $ne: true } }).lean(),
  ]);

  if (!lease) {
    const err = new Error('Lease not found');
    err.status = 404;
    throw err;
  }
  if (!tenant || !tenant.email) {
    const err = new Error('Tenant not found or has no email');
    err.status = 404;
    throw err;
  }

  const split = Array.isArray(lease.rentAndDepositDestribution?.split)
    ? lease.rentAndDepositDestribution.split
    : [];
  const normalizedTenantId = normalizeSplitTenantId(tenantId);
  const onLease = split.some((s) => normalizeSplitTenantId(s?.tenantId) === normalizedTenantId);
  if (!onLease) {
    const err = new Error('Tenant is not on this lease');
    err.status = 403;
    throw err;
  }

  const { landlordName, landlordEmail } = await resolveLandlordContext(lease.property_id);
  const propertyName = lease.property_id?.name || 'Property';
  const screeningBaseUrl =
    process.env.SCREENING_APPLICATION_BASE_URL ||
    `${(process.env.FRONTEND_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}/application/screening`;
  const applicationLink = `${screeningBaseUrl}?leaseId=${leaseId}&tenantId=${tenantId}`;
  const tenantName = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || tenant.email;
  const splitRow = split.find((s) => normalizeSplitTenantId(s?.tenantId) === normalizedTenantId);
  const resolvedScreening = hasTenantScreening(screening)
    ? normalizeScreeningArray(screening)
    : resolveTenantScreeningForEmail(splitRow, undefined);

  if (!hasTenantScreening(resolvedScreening)) {
    const err = new Error('No screening requirements found for this tenant');
    err.status = 400;
    throw err;
  }

  const appName = process.env.APP_NAME || 'PropMv';
  await emailHelper.sendEmail(
    'screening-application',
    tenant.email,
    {
      tenantName,
      landlordName,
      propertyName,
      appDisplayName: appName,
      screeningTitle: 'Complete your tenant screening',
      screeningIntro: `${landlordName} invited you to complete tenant screening for ${propertyName}. After your application is approved, you will receive a separate lease invitation email. Please use the button below to get started.`,
      screeningChecksList: buildScreeningChecksHtml(resolvedScreening),
      applicationUrl: applicationLink,
      screeningCtaText: 'Start screening',
    },
    {
      template: 'screening-application',
      subject: `Complete your tenant screening - ${propertyName}`,
      preheaderText: buildScreeningApplicationPreheader({
        landlordName,
        propertyName,
      }),
      replyTo: landlordEmail,
    }
  );

  logger.info(
    `[LeaseInvite] Delivered screening application email to ${tenant.email} (tenant ${tenantId}, lease ${leaseId})`
  );

  return {
    sent: true,
    leaseId: String(leaseId),
    tenantId: String(tenantId),
    email: tenant.email,
    channel: 'screening',
    screening: resolvedScreening,
  };
}

/**
 * Send invite emails to all tenants on a lease who do not require screening (at lease creation).
 */
async function sendLeaseInvitesForNonScreeningTenants(leaseId, options = {}) {
  const safeLeaseId = toObjectId(leaseId);
  if (!safeLeaseId) return { sent: 0 };
  const lease = await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } }).lean();
  if (!lease) return { sent: 0 };

  const split = lease.rentAndDepositDestribution?.split || [];
  let sent = 0;
  for (const s of split) {
    const screening = Array.isArray(s.screening) ? s.screening : [];
    if (hasTenantScreening(screening)) continue;
    const tid = s.tenantId;
    if (!tid) continue;
    try {
      await sendLeaseTenantInviteEmail({
        leaseId,
        tenantId: tid,
        inviterUserId: options.inviterUserId,
        forceLeaseInviteEmail: true,
      });
      sent += 1;
    } catch (err) {
      logger.error(`[LeaseInvite] Failed non-screening invite for tenant ${tid}:`, err.message);
    }
  }
  return { sent };
}

/**
 * Send in-app notifications to tenants who received lease onboarding emails.
 */
async function notifyLeaseOnboardingTenants({ leaseId, tenantIds = [] } = {}) {
  const uniqueIds = [...new Set((tenantIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!leaseId || uniqueIds.length === 0) return;

  try {
    const { notify, EVENTS } = require('../../../../../integrations/notification');
    const safeLeaseId = toObjectId(leaseId);
    if (!safeLeaseId) return;
    const lease = await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } })
      .populate('property_id', 'name')
      .lean();
    if (!lease) return;

    const unitName = lease.unitName || 'Unit';
    const propertyName = (lease.property_id && lease.property_id.name) || 'Property';

    await notify(
      EVENTS.LEASE_CREATED,
      { unitName, propertyName },
      uniqueIds,
      { leaseId: String(leaseId) }
    );
  } catch (err) {
    logger.warn('[LeaseOnboarding] Failed to send lease created notifications:', err.message);
  }
}

/**
 * After lease + tenants are committed: send screening or lease-invite email per split tenant.
 * Awaited by setupTenant so failures are logged and not lost in a detached promise.
 */
async function sendLeaseTenantOnboardingEmails({
  leaseId,
  createdTenants = [],
  tenantsData = [],
  leaseSplit = [],
  inviterUserId = null,
}) {
  if (!leaseId || !createdTenants.length) {
    return { results: [], inviteCount: 0, screeningCount: 0, failedCount: 0 };
  }

  const payloadTenantsByEmail = (tenantsData || []).reduce((acc, t) => {
    if (t?.email) acc[String(t.email).toLowerCase()] = t;
    return acc;
  }, {});

  const payloadTenantsByKey = (tenantsData || []).reduce((acc, t) => {
    if (t?.key != null) acc[String(t.key)] = t;
    return acc;
  }, {});

  const split = Array.isArray(leaseSplit) ? leaseSplit : [];
  const results = [];
  let inviteCount = 0;
  let screeningCount = 0;
  let failedCount = 0;
  const notifiedTenantIds = [];

  for (let index = 0; index < createdTenants.length; index += 1) {
    const row = createdTenants[index] || {};
    const created = row.created || row;
    const key = row.key != null ? row.key : created.key;
    const to = created && (created.email || (created.toObject ? created.toObject().email : null));
    const tenantId = String(created?._id || (created?.toObject ? created.toObject()._id : '') || '');

    if (!to || !tenantId) {
      results.push({ tenantId, email: to, skipped: true, reason: 'missing_email_or_id' });
      continue;
    }

    const payloadTenant =
      (key != null && payloadTenantsByKey[String(key)]) ||
      payloadTenantsByEmail[String(to).toLowerCase()];

    const splitEntry = resolveSplitEntryForTenantEmail(split, tenantId, index, key);
    const screening = resolveTenantScreeningForEmail(splitEntry, payloadTenant?.screening);

    try {
      if (index > 0 && ONBOARDING_EMAIL_STAGGER_MS > 0) {
        await delay(ONBOARDING_EMAIL_STAGGER_MS);
      }

      if (hasTenantScreening(screening)) {
        logger.info(
          `[LeaseOnboardingEmail] Screening only → ${to} (tenant ${tenantId}, lease ${leaseId}). ` +
          'Lease invite is sent after application approval, not at lease creation.'
        );
        await sendTenantScreeningApplicationEmail({
          leaseId: String(leaseId),
          tenantId,
          screening,
        });
        screeningCount += 1;
        notifiedTenantIds.push(tenantId);
        results.push({
          tenantId,
          email: to,
          channel: 'screening',
          sent: true,
          note: 'lease_invite_after_screening_approval',
        });
      } else {
        logger.info(
          `[LeaseOnboardingEmail] Lease invite → ${to} (tenant ${tenantId}, lease ${leaseId}). ` +
          'Check this inbox (including spam) for the lease invitation email.'
        );
        const inviteResult = await sendLeaseTenantInviteEmail({
          leaseId: String(leaseId),
          tenantId,
          inviterUserId,
          forceLeaseInviteEmail: true,
        });
        inviteCount += 1;
        notifiedTenantIds.push(tenantId);
        results.push({
          tenantId,
          email: to,
          channel: 'invite',
          sent: true,
          acknowledgeUrl: inviteResult.acknowledgeUrl,
        });
      }
    } catch (err) {
      failedCount += 1;
      logger.error(
        `[LeaseOnboardingEmail] Failed for ${to} (lease ${leaseId}, tenant ${tenantId}):`,
        err.message,
        err.stack
      );
      results.push({ tenantId, email: to, sent: false, error: err.message });
    }
  }

  const inviteRecipients = results.filter((r) => r.channel === 'invite' && r.sent).map((r) => r.email);
  const screeningRecipients = results
    .filter((r) => r.channel === 'screening' && r.sent)
    .map((r) => r.email);

  logger.info(
    `[LeaseOnboardingEmail] lease ${leaseId}: ${inviteCount} invite(s) [${inviteRecipients.join(', ') || 'none'}], ` +
    `${screeningCount} screening [${screeningRecipients.join(', ') || 'none'}], ${failedCount} failed`
  );

  await notifyLeaseOnboardingTenants({ leaseId: String(leaseId), tenantIds: notifiedTenantIds });

  return {
    results,
    inviteCount,
    screeningCount,
    failedCount,
    inviteRecipients,
    screeningRecipients,
  };
}

module.exports = {
  delay,
  ONBOARDING_EMAIL_STAGGER_MS,
  buildAcknowledgeUrl,
  splitNeedsApplication,
  hasTenantScreening,
  resolveTenantScreening,
  resolveTenantScreeningForEmail,
  resolveSplitEntryForTenantEmail,
  normalizeSplitTenantId,
  findSplitEntryForTenant,
  syncScreeningFromTenantsToSplit,
  normalizeScreeningArray,
  sendLeaseTenantInviteEmail,
  sendTenantScreeningApplicationEmail,
  sendLeaseInvitesForNonScreeningTenants,
  sendLeaseTenantOnboardingEmails,
  notifyLeaseOnboardingTenants,
};
