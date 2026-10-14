/**
 * ------------------------------------------------------------------
 * File: portalInvitation.service.js
 * Module: Src Shared Modules Auth Services
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * owner.service, application.service, leaseTenantInviteDelivery.service, tenant.service
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../../users/models/user.model');
const {
  resolveInvitationRoleName,
  userMatchesInvitationRole,
  resolveUserRole,
  resolveUserRoleName,
} = require('../../../../common/helpers/companyRoleHelper');
const { getHOAOwnerRoleRefs } = require('../../../../common/helpers/hoaOwnerRole');
const PortalInvitation = require('../models/portalInvitation.model');
const emailHelper = require('../../../../common/helpers/emailHelper');
const { logInviteUrl } = require('../../../../common/helpers/inviteLinkLogger');
const { createAuditLogInBackground } = require('../../audit/service/auditLog.service');
const { USER_STATUSES } = require('../../../../common/constants/user');
const {
  PORTAL_ONBOARDING_STATUS,
  PORTAL_INVITATION_PORTAL,
  PORTAL_INVITATION_STATUS,
} = require('../../../../common/constants/portalOnboarding');
const { generateAccessToken, generateRefreshToken } = require('../../../../common/helpers/jwtHelper');
const { ClockService, DateUtil } = require('../../../../common/date');
const logger = require('../../../../common/logger');

const INVITE_EXPIRY_HOURS = Number(process.env.PORTAL_INVITE_EXPIRY_HOURS || 168);

/**
 * hash Token
 *
 * Performs logic operations for hashToken.
 *
 * @param raw - Request/input argument
 * @returns Operations result
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

/**
 * mask Email
 *
 * Performs logic operations for maskEmail.
 *
 * @param email - Request/input argument
 * @returns Operations result
 */
function maskEmail(email) {
  const s = String(email || '');
  const [local, domain] = s.split('@');
  if (!domain) return '***';
  if (!local || local.length <= 1) return `***@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 1, 6))}@${domain}`;
}

/**
 * normalize Invite Email
 *
 * Performs logic operations for normalizeInviteEmail.
 *
 * @param email - Request/input argument
 * @returns Operations result
 */
function normalizeInviteEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * assert Invitation Email Matches User
 *
 * Performs logic operations for assertInvitationEmailMatchesUser.
 *
 * @param inv - Request/input argument
 * @param user - Request/input argument
 * @returns Operations result
 */
function assertInvitationEmailMatchesUser(inv, user) {
  const inviteEmail = normalizeInviteEmail(inv.inviteeEmail);
  const userEmail = normalizeInviteEmail(user.email);
  if (inviteEmail && userEmail && inviteEmail !== userEmail) {
    const err = new Error(
      'This invitation link is no longer valid because the account email was changed. Ask your administrator to resend the invitation.'
    );
    err.status = 400;
    throw err;
  }
}

/**
 * resolve Portal Invite Verify Base Url
 *
 * Performs logic operations for resolvePortalInviteVerifyBaseUrl.
 *
 * @returns Operations result
 */
function resolvePortalInviteVerifyBaseUrl() {
  const base =
    process.env.PORTAL_INVITE_VERIFY_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.INVITE_ACCEPT_URL ||
    '';
  return String(base || '').replace(/\/$/, '');
}

/**
 * append Portal Audit
 *
 * Performs logic operations for appendPortalAudit.
 *
 * @param invDoc - Request/input argument
 * @param type - Request/input argument
 * @param meta - Request/input argument
 * @returns Operations result
 */
function appendPortalAudit(invDoc, type, meta = null) {
  invDoc.auditEvents = invDoc.auditEvents || [];
  invDoc.auditEvents.push({ at: ClockService.now(), type, meta });
}

async function assertInviterRole(inviterUserId, allowedRoleNames) {
  if (!inviterUserId || !mongoose.Types.ObjectId.isValid(String(inviterUserId))) {
    const err = new Error('Invalid inviter user ID. Please ensure you are logged in with a valid account.');
    err.status = 400;
    throw err;
  }
  
  // Fetch user with basic fields
  const u = await User.findById(inviterUserId)
    .select('companyId companyRoleId')
    .lean();
  
  if (!u) {
    const err = new Error(`Inviter user not found (ID: ${inviterUserId}). Your session may be invalid. Please log out and log in again.`);
    err.status = 403;
    throw err;
  }
  
  const roleName = await resolveUserRoleName(u);
  
  if (!roleName) {
    const err = new Error(`Your account does not have a valid role assigned. Please contact support.`);
    err.status = 403;
    throw err;
  }
  
  if (!allowedRoleNames.includes(roleName)) {
    const err = new Error(`You are not allowed to send this invitation. Required roles: ${allowedRoleNames.join(', ')}. Your role: ${roleName}`);
    err.status = 403;
    throw err;
  }
}

async function supersedePendingInvites(inviteeUserId, portal) {
  await PortalInvitation.updateMany(
    {
      inviteeUserId,
      portal,
      status: PORTAL_INVITATION_STATUS.PENDING,
    },
    { $set: { status: PORTAL_INVITATION_STATUS.SUPERSEDED, supersededAt: ClockService.now() } }
  );
}

const HoaModel = () => require('../../../../portals/hoa-board/modules/hoa/model/hoa.model');

/**
 * Persistable HOA snapshot for HOA Owner invitations (drives /my-hoas after password setup).
 */
async function normalizeHoaOwnerInviteContext(raw) {
  if (!raw || !raw.hoaId || !mongoose.Types.ObjectId.isValid(String(raw.hoaId))) {
    return null;
  }
  const HOA = HoaModel();
  const hoa = await HOA.findById(raw.hoaId).select('name numberOfUnits associationType propertyAddress').lean();
  if (!hoa) {
    return { hoaId: raw.hoaId };
  }
  return {
    hoaId: hoa._id,
    communityName: hoa.name,
    numberOfUnits: hoa.numberOfUnits,
    associationType: hoa.associationType,
    propertyAddress: hoa.propertyAddress,
  };
}

/**
 * Create a portal invite + send email (HOA Owner). Caller must persist owner user with
 * portalOnboardingStatus invitation_sent when appropriate.
 */
async function issueHoaOwnerPortalInvite({
  inviteeUserId,
  inviterUserId,
  tenantName,
  hoaContext,
  skipRecipientValidation = false,
}) {
  await assertInviterRole(inviterUserId, ['HOA Board Member']);
  const ownerRoleRefs = await getHOAOwnerRoleRefs();
  if (!ownerRoleRefs.roleId) {
    const err = new Error('HOA Owner role not found');
    err.status = 500;
    throw err;
  }

  const invitee = await User.findById(inviteeUserId).select('email firstName companyId companyRoleId isDeleted').lean();
  if (!invitee || invitee.isDeleted) {
    const err = new Error('Invitee not found');
    err.status = 404;
    throw err;
  }

  const expectedInvite = {
    intendedCompanyId: ownerRoleRefs.companyId,
    intendedRoleId: ownerRoleRefs.roleId,
  };
  if (!userMatchesInvitationRole(invitee, expectedInvite)) {
    const err = new Error('Invitation role mismatch for this account');
    err.status = 400;
    throw err;
  }

  const inviter = await User.findById(inviterUserId).select('firstName lastName email').lean();
  const landlordName =
    `${inviter?.firstName || ''} ${inviter?.lastName || ''}`.trim() || inviter?.email || 'PropMv';

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  await supersedePendingInvites(invitee._id, PORTAL_INVITATION_PORTAL.HOA_OWNER);

  const storedContext = await normalizeHoaOwnerInviteContext(hoaContext);

  const inv = await PortalInvitation.create({
    inviteeUserId: invitee._id,
    inviteeEmail: invitee.email,
    inviterUserId,
    intendedCompanyId: ownerRoleRefs.companyId || undefined,
    intendedRoleId: ownerRoleRefs.roleId,
    portal: PORTAL_INVITATION_PORTAL.HOA_OWNER,
    tokenHash,
    expiresAt,
    status: PORTAL_INVITATION_STATUS.PENDING,
    context: storedContext,
    auditEvents: [{ at: ClockService.now(), type: 'invitation_sent', meta: { channel: 'email' } }],
  });

  const base = resolvePortalInviteVerifyBaseUrl();
  if (!base) {
    await PortalInvitation.deleteOne({ _id: inv._id });
    const err = new Error(
      'Server misconfiguration: set PORTAL_INVITE_VERIFY_BASE_URL or FRONTEND_BASE_URL for invitation links.'
    );
    err.status = 500;
    throw err;
  }

  const inviteUrl = `${base}/verify-account/${invitee._id}/${rawToken}`;
  const acknowledgeBlock = '';
  const communityName = storedContext && storedContext.communityName ? storedContext.communityName : null;
  const subject = emailHelper.inviteEmailSubjectForHoaOwner({
    inviterDisplayName: landlordName,
    communityName,
    appName: process.env.APP_NAME || 'PropMv',
  });

  logInviteUrl({
    kind: 'HOA Owner Portal Verification',
    email: invitee.email,
    url: inviteUrl,
    template: 'invite',
    meta: {
      userId: String(invitee._id),
      community: communityName,
      expires: `${INVITE_EXPIRY_HOURS} hours`,
    },
  });

  await emailHelper.sendEmail('invite', invitee.email, {
    tenantName: tenantName || invitee.firstName || 'there',
    landlordName,
    inviteAudience: 'hoa_owner',
    communityName,
    appName: process.env.APP_NAME || 'PropMv',
    inviteUrl,
    acknowledgeBlock,
  }, {
    template: 'invite',
    subject,
    // Caller already ran assertEmailCanReceive (MX + RCPT); skip duplicate probe latency
    skipRecipientValidation: Boolean(skipRecipientValidation),
    communityName,
    senderUserId: inviterUserId,
    hoaId: storedContext?.hoaId || null,
  });

  createAuditLogInBackground({
    module: 'PortalInvitation',
    event: 'invitation_sent',
    createdBy: inviterUserId,
    after: { invitationId: String(inv._id), portal: PORTAL_INVITATION_PORTAL.HOA_OWNER, inviteeUserId: String(invitee._id) },
  });

  return { inviteExpiresAt: expiresAt, invitationId: inv._id, inviteUrl };
}

/**
 * Landlord-invited tenant: secure link + optional lease acknowledge follow-up URL in email body.
 */
async function issueLandlordTenantPortalInvite({
  inviteeUserId,
  inviterUserId,
  landlordDisplayName,
  acknowledgeUrl,
}) {
  await assertInviterRole(inviterUserId, ['Landlord', 'Property Manager', 'Administrator']);

  const invitee = await User.findById(inviteeUserId).lean();
  if (!invitee || invitee.isDeleted) {
    const err = new Error('Invitee not found');
    err.status = 404;
    throw err;
  }

  // Check if invitee has Tenant role from company
  let isTenant = false;
  let tenantRoleId = null;

  if (invitee.companyId && invitee.companyRoleId) {
    const Company = require('../../company/models/company.model');
    const company = await Company.findOne({ _id: invitee.companyId, isDeleted: { $ne: true } }).lean();
    if (company && company.roles) {
      const userRole = company.roles.find(
        r => r._id.toString() === invitee.companyRoleId.toString() && r.isActive
      );
      if (userRole && userRole.name === 'Tenant') {
        isTenant = true;
        tenantRoleId = userRole._id;
      }
    }
  }

  if (!isTenant) {
    const err = new Error('Invitation role mismatch for this account - user must be a Tenant');
    err.status = 400;
    throw err;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  await supersedePendingInvites(invitee._id, PORTAL_INVITATION_PORTAL.LANDLORD_TENANT);

  const inv = await PortalInvitation.create({
    inviteeUserId: invitee._id,
    inviteeEmail: invitee.email,
    inviterUserId,
    intendedRoleId: tenantRoleId,
    portal: PORTAL_INVITATION_PORTAL.LANDLORD_TENANT,
    tokenHash,
    expiresAt,
    status: PORTAL_INVITATION_STATUS.PENDING,
    context: acknowledgeUrl ? { acknowledgeUrl } : null,
    auditEvents: [{ at: ClockService.now(), type: 'invitation_sent', meta: { channel: 'email' } }],
  });

  const base = resolvePortalInviteVerifyBaseUrl();
  if (!base) {
    await PortalInvitation.deleteOne({ _id: inv._id });
    const err = new Error(
      'Server misconfiguration: set PORTAL_INVITE_VERIFY_BASE_URL or FRONTEND_BASE_URL for invitation links.'
    );
    err.status = 500;
    throw err;
  }

  const verifyUrl = `${base}/verify-account/${invitee._id}/${rawToken}`;
  const inviteUrl = acknowledgeUrl || verifyUrl;
  const acknowledgeBlock = acknowledgeUrl
    ? `<p class="pmv-muted" style="font-size:13px;line-height:1.55;margin-top:16px">After you sign in, please <a href="${acknowledgeUrl}" style="color:#f97316;font-weight:600">acknowledge your lease invite</a> to continue.</p>`
    : '';

  const inviterLabel = landlordDisplayName || 'your landlord';
  await emailHelper.sendEmail('invite', invitee.email, {
    tenantName: `${invitee.firstName || ''} ${invitee.lastName || ''}`.trim() || 'there',
    landlordName: inviterLabel,
    appName: process.env.APP_NAME || 'PropMv',
    inviteUrl,
    acknowledgeLink: inviteUrl,
    acknowledgeBlock,
  }, { template: 'invite' });

  createAuditLogInBackground({
    module: 'PortalInvitation',
    event: 'invitation_sent',
    createdBy: inviterUserId,
    after: {
      invitationId: String(inv._id),
      portal: PORTAL_INVITATION_PORTAL.LANDLORD_TENANT,
      inviteeUserId: String(invitee._id),
    },
  });

  return { inviteExpiresAt: expiresAt, invitationId: inv._id };
}

async function validateInvite({ userId, token }) {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    const err = new Error('Invalid invitation link');
    err.status = 400;
    throw err;
  }
  if (!token || String(token).length < 16) {
    const err = new Error('Invalid invitation link');
    err.status = 400;
    throw err;
  }

  const tokenHash = hashToken(token);
  const inv = await PortalInvitation.findOne({
    inviteeUserId: userId,
    tokenHash,
    status: PORTAL_INVITATION_STATUS.PENDING,
  }).lean();

  if (!inv) {
    const err = new Error('This invitation link is invalid or has already been used.');
    err.status = 400;
    throw err;
  }
  if (inv.expiresAt < ClockService.now()) {
    await PortalInvitation.updateOne({ _id: inv._id }, { $set: { status: PORTAL_INVITATION_STATUS.EXPIRED } });
    const err = new Error('This invitation has expired. Ask your administrator to resend it.');
    err.status = 400;
    throw err;
  }

  const user = await User.findById(userId).select('firstName email portalOnboardingStatus').lean();
  if (!user || user.isDeleted) {
    const err = new Error('Account not found');
    err.status = 404;
    throw err;
  }

  assertInvitationEmailMatchesUser(inv, user);

  if (user.portalOnboardingStatus === PORTAL_ONBOARDING_STATUS.INVITATION_SENT) {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION,
        },
      }
    );
    await PortalInvitation.updateOne(
      { _id: inv._id },
      { $push: { auditEvents: { at: ClockService.now(), type: 'invitation_opened_validate', meta: null } } }
    );
    createAuditLogInBackground({
      module: 'PortalInvitation',
      event: 'invitation_accepted_validation',
      after: { invitationId: String(inv._id), inviteeUserId: String(userId) },
    });
  }

  const intendedRoleName = await resolveInvitationRoleName(inv);

  return {
    verified: true,
    firstName: user.firstName || '',
    emailMasked: maskEmail(user.email),
    intendedRoleName,
    message: 'Your account has been successfully verified. Please set your password.',
    acknowledgeUrl: inv.context && inv.context.acknowledgeUrl ? inv.context.acknowledgeUrl : null,
    expiresAt: inv.expiresAt,
  };
}

async function completeInvite({ userId, token, newPassword, confirmPassword, loginMeta }) {
  const { isValidEncryptedPassword, decryptIfEnabled, isEncryptionEnabled } = require('../../../../common/helpers/cryptoHelper');
  const { decryptedPasswordSchema } = require('../validators/auth.validator');

  let plainNew = newPassword;
  let plainConfirm = confirmPassword;
  if (isEncryptionEnabled()) {
    if (!isValidEncryptedPassword(newPassword) || !isValidEncryptedPassword(confirmPassword)) {
      const err = new Error('Passwords must be encrypted using AES-256-CBC base64 encoding');
      err.status = 400;
      throw err;
    }
    plainNew = decryptIfEnabled(newPassword);
    plainConfirm = decryptIfEnabled(confirmPassword);
  }
  const pwValidation = decryptedPasswordSchema.validate({ password: plainNew }, { abortEarly: false });
  if (pwValidation.error) {
    const err = new Error('Password validation failed: ' + pwValidation.error.details.map((d) => d.message).join('; '));
    err.status = 400;
    throw err;
  }
  if (plainNew !== plainConfirm) {
    const err = new Error('New password and confirm password do not match');
    err.status = 400;
    throw err;
  }

  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId)) || !token) {
    const err = new Error('Invalid invitation link');
    err.status = 400;
    throw err;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const tokenHash = hashToken(token);
    const inv = await PortalInvitation.findOne({
      inviteeUserId: userId,
      tokenHash,
      status: PORTAL_INVITATION_STATUS.PENDING,
    }).session(session);

    if (!inv) {
      const err = new Error('This invitation link is invalid or has already been used.');
      err.status = 400;
      throw err;
    }
    if (inv.expiresAt < ClockService.now()) {
      inv.status = PORTAL_INVITATION_STATUS.EXPIRED;
      appendPortalAudit(inv, 'invitation_expired_on_complete');
      await inv.save({ session });
      await session.commitTransaction();
      session.endSession();
      const err = new Error('This invitation has expired. Ask your administrator to resend it.');
      err.status = 400;
      throw err;
    }

    const user = await User.findById(userId)
      .select('email firstName companyId companyRoleId isDeleted portalOnboardingStatus')
      .session(session);
    if (!user || user.isDeleted) {
      const err = new Error('Account not found');
      err.status = 404;
      throw err;
    }
    assertInvitationEmailMatchesUser(inv, user);
    if (!userMatchesInvitationRole(user, inv)) {
      const err = new Error('Account role does not match this invitation');
      err.status = 400;
      throw err;
    }

    const hashed = await bcrypt.hash(plainNew, 10);
    user.password = hashed;
    user.status = USER_STATUSES.ACTIVE;
    user.portalOnboardingStatus = PORTAL_ONBOARDING_STATUS.ACTIVE;
    user.mfaLoginVerifiedAt = ClockService.now();
    user.failedLoginAttempts = 0;
    user.lockAccount = false;
    user.lockUntil = null;
    user.mfaOtp = undefined;
    user.mfaOtpExpiresAt = undefined;
    user.mfaOtpAction = undefined;

    const refreshToken = generateRefreshToken({ sub: user._id.toString() });
    user.refreshToken = refreshToken;

    if (inv.portal === PORTAL_INVITATION_PORTAL.HOA_OWNER && inv.context && inv.context.hoaId) {
      const HOA = HoaModel();
      const hoa = await HOA.findById(inv.context.hoaId)
        .select('name numberOfUnits associationType propertyAddress')
        .session(session)
        .lean();
      if (hoa) {
        user.hoaInfo = user.hoaInfo || {};
        user.hoaInfo.hoaId = hoa._id;
        user.hoaInfo.communityName = hoa.name;
        if (hoa.numberOfUnits != null) user.hoaInfo.numberOfUnits = hoa.numberOfUnits;
        if (hoa.associationType) user.hoaInfo.associationType = hoa.associationType;
        if (hoa.propertyAddress) user.hoaInfo.propertyAddress = hoa.propertyAddress;
      }
    }

    await user.save({ session });

    inv.status = PORTAL_INVITATION_STATUS.ACCEPTED;
    inv.consumedAt = ClockService.now();
    appendPortalAudit(inv, 'password_setup_completed');
    appendPortalAudit(inv, 'verification_completed');
    await inv.save({ session });

    await session.commitTransaction();
    session.endSession();

    const resolvedRole = await resolveUserRole(user);
    const roleName = resolvedRole?.name;
    const privileges = Array.isArray(resolvedRole?.privileges) ? resolvedRole.privileges : [];
    const accessToken = generateAccessToken({ sub: user._id.toString(), role: roleName }, privileges);

    const ip = loginMeta && loginMeta.ip ? loginMeta.ip : null;
    const userAgent = loginMeta && loginMeta.userAgent ? loginMeta.userAgent : null;

    createAuditLogInBackground({
      module: 'PortalInvitation',
      event: 'password_setup_completed',
      createdBy: user._id,
      ipAddress: ip,
      after: {
        invitationId: String(inv._id),
        inviteeUserId: String(user._id),
        userAgent,
      },
    });

    if (inv.portal === PORTAL_INVITATION_PORTAL.HOA_OWNER) {
      scheduleHoaOwnerInvoiceGenerationAfterVerification(user._id);
    }

    return {
      accessToken,
      refreshToken,
      user: user.toSafeJSON ? user.toSafeJSON() : user,
      message: "You've successfully set your password. We're logging you in now.",
      acknowledgeUrl: inv.context && inv.context.acknowledgeUrl ? inv.context.acknowledgeUrl : null,
      privileges,
    };
  } catch (e) {
    try {
      await session.abortTransaction();
    } catch (_ignore) {
      /* transaction may already be committed */
    }
    try {
      session.endSession();
    } catch (_ignore2) {
      /* ignore */
    }
    throw e;
  }
}

/**
 * HOA admin sends invite to a vendor user so they can set their password and log in.
 */
async function issueVendorPortalInvite({
  inviteeUserId,
  inviterUserId,
  hoaContext,
}) {
  await assertInviterRole(inviterUserId, ['HOA Board Member']);

  const { getVendorRoleRefs } = require('../../../../common/helpers/hoaVendorRole');
  const vendorRoleRefs = await getVendorRoleRefs();
  if (!vendorRoleRefs.roleId) {
    const err = new Error('Vendor role not found');
    err.status = 500;
    throw err;
  }

  const invitee = await User.findById(inviteeUserId)
    .select('email firstName companyId companyRoleId isDeleted')
    .lean();
  if (!invitee || invitee.isDeleted) {
    const err = new Error('Vendor not found');
    err.status = 404;
    throw err;
  }

  const expectedInvite = {
    intendedCompanyId: vendorRoleRefs.companyId,
    intendedRoleId: vendorRoleRefs.roleId,
  };
  if (!userMatchesInvitationRole(invitee, expectedInvite)) {
    const err = new Error('This user is not a vendor account');
    err.status = 400;
    throw err;
  }

  const inviter = await User.findById(inviterUserId).select('firstName lastName email').lean();
  const inviterName =
    `${inviter?.firstName || ''} ${inviter?.lastName || ''}`.trim() || inviter?.email || 'PropMv';

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = DateUtil.fromEpoch(ClockService.nowEpoch() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  await supersedePendingInvites(invitee._id, PORTAL_INVITATION_PORTAL.VENDOR);

  const storedContext = hoaContext?.hoaId ? { hoaId: hoaContext.hoaId } : null;

  const inv = await PortalInvitation.create({
    inviteeUserId: invitee._id,
    inviteeEmail: invitee.email,
    inviterUserId,
    intendedCompanyId: vendorRoleRefs.companyId || undefined,
    intendedRoleId: vendorRoleRefs.roleId,
    portal: PORTAL_INVITATION_PORTAL.VENDOR,
    tokenHash,
    expiresAt,
    status: PORTAL_INVITATION_STATUS.PENDING,
    context: storedContext,
    auditEvents: [{ at: ClockService.now(), type: 'invitation_sent', meta: { channel: 'email' } }],
  });

  // Ensure portalOnboardingStatus reflects invitation_sent
  await User.updateOne(
    { _id: invitee._id },
    { $set: { portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT } }
  );

  const base = resolvePortalInviteVerifyBaseUrl();
  if (!base) {
    await PortalInvitation.deleteOne({ _id: inv._id });
    const err = new Error(
      'Server misconfiguration: set PORTAL_INVITE_VERIFY_BASE_URL or FRONTEND_BASE_URL for invitation links.'
    );
    err.status = 500;
    throw err;
  }

  const inviteUrl = `${base}/verify-account/${invitee._id}/${rawToken}`;
  let communityName = null;
  if (storedContext?.hoaId) {
    try {
      const hoa = await HoaModel().findById(storedContext.hoaId).select('name').lean();
      communityName = hoa?.name || null;
    } catch (_err) {
      communityName = null;
    }
  }
  const appName = process.env.APP_NAME || 'PropMv';
  const subject = emailHelper.inviteEmailSubjectForVendor({
    inviterDisplayName: inviterName,
    communityName,
    appName,
  });
  await emailHelper.sendEmail('invite', invitee.email, {
    tenantName: invitee.firstName || 'there',
    landlordName: inviterName,
    inviteAudience: 'vendor',
    communityName,
    appName,
    inviteUrl,
    acknowledgeBlock: '',
  }, { template: 'invite', subject });

  createAuditLogInBackground({
    module: 'PortalInvitation',
    event: 'invitation_sent',
    createdBy: inviterUserId,
    after: { invitationId: String(inv._id), portal: PORTAL_INVITATION_PORTAL.VENDOR, inviteeUserId: String(invitee._id) },
  });

  return { inviteExpiresAt: expiresAt, invitationId: inv._id };
}

function scheduleHoaOwnerInvoiceGenerationAfterVerification(ownerId) {
  if (!ownerId) return;
  const ownerIdStr = String(ownerId);
  setImmediate(() => {
    Promise.resolve()
      .then(() => {
        const unitService = require('../../../../portals/hoa-board/modules/owners/services/unit.service');
        return unitService.ensureInvoicesWhenOwnerVerified(ownerIdStr, {
          userId: ownerIdStr,
          source: 'owner-verified',
        });
      })
      .catch((err) => {
        logger.warn(
          '[completeInvite] invoice generation after owner verification failed:',
          err?.message || err
        );
      });
  });
}

module.exports = {
  assertInviterRole,
  issueHoaOwnerPortalInvite,
  issueLandlordTenantPortalInvite,
  issueVendorPortalInvite,
  validateInvite,
  completeInvite,
  hashToken,
  maskEmail,
  normalizeInviteEmail,
  assertInvitationEmailMatchesUser,
};
