/**
 * ------------------------------------------------------------------
 * File: hoa.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * hoaDataIsolation, hoa.controller, auth.service
 * ------------------------------------------------------------------
 */

const crypto = require('crypto');
const HOA = require('../model/hoa.model');
const HOAMembership = require('../model/hoaMembership.model');
const Property = require('../../property/model/property.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { resolveUserRoleName } = require('../../../../../common/helpers/companyRoleHelper');
const { logActivity } = require('../../dashboard/service/activity.service');
const { ClockService, DateUtil, MS_PER_DAY } = require('../../../../../common/date');
const { invalidateHoaCache } = require('../../../../../middleware/hoaDataIsolation');
const {
  notifyBoardMemberUpdatedInAppInBackground,
  notifyBoardMemberDeletedInAppInBackground,
  notifyBoardMemberInviteAcceptedInAppInBackground,
} = require('../../../../../common/helpers/hoaCommunityNotify.helper');
const {
  clearBoardAccessBlocked,
  handleBoardMemberAccessRemoved,
  buildAccessRemovedLoginMessage,
} = require('../../../../../common/helpers/hoaBoardMemberAccess.helper');
const config = require('../../../../../config/default');

const {
  getCommunityOnboardingStatus,
} = require('../helpers/hoaOnboardingStatus.helper');
const {
  withNewHoaTrial,
  presentSubscription,
  subscribedPatch,
} = require('./hoaSubscription.service');
const { notifyTrialStarted } = require('./hoaTrialNotification.service');

const HOA_PROFILE_SELECT = 'name createdAt numberOfUnits associationType propertyAddress trialStartAt trialEndAt trialStatus subscriptionStatus';

function getBoardInviteExpiryHours() {
  const hours = Number(config.hoa?.boardInviteExpiryHours ?? 48);
  return Number.isFinite(hours) && hours > 0 ? hours : 48;
}
const HOA_NAME_MIN_LENGTH = 2;
const HOA_NAME_MAX_LENGTH = 100;
const HOA_UNITS_MIN = 1;
const HOA_UNITS_MAX = 1_000_000;

/**
 * normalize Invite Email
 *
 * Performs logic operations for normalizeInviteEmail.
 *
 * @param email - Request/input argument
 * @returns Operations result
 */
function normalizeInviteEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Invalid email address');
  }
  return normalized;
}

/**
 * Active memberships whose linked user is missing or soft-deleted should be revoked.
 * Uses raw membership rows (before populate) so hard-deleted users are detected.
 */
async function findStaleActiveMembershipIds(memberships) {
  const active = (memberships || []).filter((m) => m.status === 'active');
  if (active.length === 0) return [];

  const userIds = active.map((m) => m.userId).filter(Boolean);
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select('isDeleted').lean()
    : [];
  const userById = new Map(users.map((u) => [String(u._id), u]));

  return active
    .filter((m) => {
      if (!m.userId) return true;
      const user = userById.get(String(m.userId));
      return !user || user.isDeleted === true;
    })
    .map((m) => m._id);
}

async function revokeMembershipsByIds(membershipIds) {
  if (!membershipIds?.length) return;
  await HOAMembership.updateMany(
    { _id: { $in: membershipIds } },
    { $set: { status: 'revoked' }, $unset: { inviteToken: '', inviteTokenExpiresAt: '' } }
  );
}

async function isActiveMembershipLinkedToLiveUser(membership) {
  if (!membership || membership.status !== 'active') return false;
  if (!membership.userId) return false;
  const user = await User.findById(membership.userId).select('isDeleted').lean();
  return Boolean(user && user.isDeleted !== true);
}

async function assertActiveAdmin(hoaId, adminUserId) {
  const admin = await HOAMembership.findOne({ hoaId, userId: adminUserId, status: 'active', role: 'admin' }).lean();
  if (!admin) throw new Error('Only HOA admins can perform this action');
  return admin;
}

async function assertNotLastActiveAdmin(hoaId, target) {
  if (target.status === 'active' && target.role === 'admin') {
    const adminCount = await HOAMembership.countDocuments({ hoaId, status: 'active', role: 'admin' });
    if (adminCount <= 1) {
      throw new Error('Cannot remove the only active admin for this HOA');
    }
  }
}

/**
 * resolve Membership Email
 *
 * Performs logic operations for resolveMembershipEmail.
 *
 * @param membership - Request/input argument
 * @returns Operations result
 */
function resolveMembershipEmail(membership) {
  const top = membership.email != null ? String(membership.email).trim() : '';
  if (top && top !== 'undefined') return top.toLowerCase();
  const userEmail = membership.userId?.email;
  if (userEmail != null) {
    const normalized = String(userEmail).trim().toLowerCase();
    if (normalized && normalized !== 'undefined') return normalized;
  }
  return '';
}

/**
 * member Display Name
 *
 * Performs logic operations for memberDisplayName.
 *
 * @param membership - Request/input argument
 * @param userDoc - Request/input argument
 * @returns Operations result
 */
function memberDisplayName(membership, userDoc) {
  if (userDoc?.firstName) {
    return `${userDoc.firstName} ${userDoc.lastName || ''}`.trim();
  }
  return resolveMembershipEmail(membership) || 'Board member';
}

async function syncHoaInfoToMembers(hoaId, hoa) {
  const memberships = await HOAMembership.find({
    hoaId,
    status: 'active',
    userId: { $exists: true, $ne: null },
  })
    .select('userId')
    .lean();
  if (!memberships.length) return;

  const userIds = [...new Set(memberships.map((m) => m.userId))];
  const update = {
    'hoaInfo.hoaId': hoa._id,
    'hoaInfo.communityName': hoa.name,
  };
  if (hoa.associationType !== undefined) update['hoaInfo.associationType'] = hoa.associationType || '';
  if (hoa.propertyAddress !== undefined) update['hoaInfo.propertyAddress'] = hoa.propertyAddress || '';
  if (hoa.numberOfUnits != null) update['hoaInfo.numberOfUnits'] = hoa.numberOfUnits;

  await User.updateMany({ _id: { $in: userIds }, 'hoaInfo.hoaId': hoaId }, { $set: update });

  // Batch-count active memberships per user to avoid N+1 queries
  const membershipCounts = await HOAMembership.aggregate([
    { $match: { userId: { $in: userIds }, status: 'active' } },
    { $group: { _id: '$userId', count: { $sum: 1 } } },
  ]);
  const countByUser = new Map(membershipCounts.map((r) => [String(r._id), r.count]));

  const singleCommunityIds = userIds.filter((uid) => (countByUser.get(String(uid)) || 0) === 1);
  if (singleCommunityIds.length > 0) {
    await User.updateMany({ _id: { $in: singleCommunityIds } }, { $set: update });
  }
}

async function countExistingHoaUnits(hoaId) {
  return Property.countDocuments({
    hoaId,
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  });
}

/**
 * validate Hoa Community Name
 *
 * Performs logic operations for validateHoaCommunityName.
 *
 * @param name - Request/input argument
 * @returns Operations result
 */
function validateHoaCommunityName(name) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < HOA_NAME_MIN_LENGTH) {
    throw new Error(`Community name must be at least ${HOA_NAME_MIN_LENGTH} characters`);
  }
  if (trimmed.length > HOA_NAME_MAX_LENGTH) {
    throw new Error(`Community name must not exceed ${HOA_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * validate Hoa Number Of Units
 *
 * Performs logic operations for validateHoaNumberOfUnits.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function validateHoaNumberOfUnits(value) {
  if (value === undefined || value === null || value === '') {
    throw new Error('Number of units is required');
  }
  const num = Number(value);
  if (!Number.isInteger(num)) {
    throw new Error('Number of units must be a whole number');
  }
  if (num < HOA_UNITS_MIN) {
    throw new Error(`Number of units must be at least ${HOA_UNITS_MIN}`);
  }
  if (num > HOA_UNITS_MAX) {
    throw new Error('Number of units seems too large');
  }
  return num;
}

/**
 * If an HOA Board Member completed signup with hoaInfo but has no active membership yet,
 * create the HOA row + admin membership. Idempotent and safe for existing invited users.
 */
async function ensurePrimaryHOAFromUserProfile(userId) {
  const { fetchUserWithResolvedRole } = require('../../../../../common/helpers/companyRoleHelper');
  const [{ user, role }, activeCount] = await Promise.all([
    fetchUserWithResolvedRole(userId, 'role companyId companyRoleId hoaInfo email'),
    HOAMembership.countDocuments({ userId, status: 'active' }),
  ]);
  if (!user) return null;
  const roleName = role?.name || null;
  if (roleName !== 'HOA Board Member') return null;

  if (activeCount > 0) return null;

  const info = user.hoaInfo;
  const communityName = info && info.communityName ? String(info.communityName).trim() : '';
  const stableHoaId = info && info.hoaId ? info.hoaId : null;
  if (!communityName && !stableHoaId) return null;

  let hoa;
  if (stableHoaId) {
    hoa = await HOA.findById(stableHoaId);
  }

  if (!hoa && communityName) {
    // Fallback: find by name (handles legacy users without hoaId)
    hoa = await HOA.findOne({ createdBy: userId, name: communityName, isDeleted: { $ne: true } });
  }

  if (!hoa && communityName) {
    const hoaPayload = {
      name: communityName,
      createdBy: userId,
      numberOfUnits: info.numberOfUnits,
      associationType: info.associationType,
      propertyAddress: info.propertyAddress,
    };
    if (stableHoaId) hoaPayload._id = stableHoaId;
    hoa = await HOA.create(withNewHoaTrial(hoaPayload));
    notifyTrialStarted(hoa).catch(() => {});

    // Write the confirmed hoaId back to the user profile
    await User.updateOne(
      { _id: userId },
      { $set: { 'hoaInfo.hoaId': hoa._id } }
    );
  } else if (hoa && info && (info.numberOfUnits != null || info.associationType || info.propertyAddress)) {
    await HOA.updateOne(
      { _id: hoa._id },
      {
        $set: {
          ...(info.numberOfUnits != null ? { numberOfUnits: info.numberOfUnits } : {}),
          ...(info.associationType ? { associationType: info.associationType } : {}),
          ...(info.propertyAddress ? { propertyAddress: info.propertyAddress } : {}),
        },
      }
    );
    hoa = await HOA.findById(hoa._id);
    // Ensure hoaId is synced on user profile
    if (!stableHoaId || String(stableHoaId) !== String(hoa._id)) {
      await User.updateOne({ _id: userId }, { $set: { 'hoaInfo.hoaId': hoa._id } });
    }
  }

  if (!hoa) return null;

  const hasActiveMembership = await HOAMembership.exists({
    hoaId: hoa._id,
    userId,
    status: 'active',
  });
  if (!hasActiveMembership) {
    const blockedMembership = await HOAMembership.exists({
      hoaId: hoa._id,
      userId,
      status: { $in: ['revoked', 'pending'] },
    });
    if (blockedMembership) return hoa;

    const memberEmail = resolveMembershipEmail({ email: user.email, userId: user });
    if (!memberEmail) throw new Error('User email is required to create board membership');
    await HOAMembership.create({
      hoaId: hoa._id,
      userId,
      email: memberEmail,
      role: 'admin',
      status: 'active',
      invitedBy: userId,
    });
  }

  return hoa;
}

async function getInvitePreview(token) {
  const raw = String(token || '').trim();
  if (!raw) throw new Error('Invitation token is required');
  const membership = await HOAMembership.findOne({ inviteToken: raw, status: 'pending' })
    .populate('hoaId', 'name numberOfUnits associationType propertyAddress')
    .lean();
  if (!membership || !membership.hoaId) throw new Error('Invalid or expired invitation');
  if (!membership.inviteTokenExpiresAt || membership.inviteTokenExpiresAt < ClockService.now()) {
    throw new Error('This invitation has expired. Ask your HOA admin to send a new one.');
  }

  const inviteEmail = String(membership.email || '').trim().toLowerCase();
  const existingUser = inviteEmail
    ? await User.findOne({ email: inviteEmail, isDeleted: { $ne: true } })
      .select('_id portalOnboardingStatus')
      .lean()
    : null;

  // Users still in owner/tenant invite onboarding cannot sign in with a password yet.
  const onboardingBlocked =
    existingUser &&
    (existingUser.portalOnboardingStatus === 'invitation_sent' ||
      existingUser.portalOnboardingStatus === 'pending_verification');

  return {
    hoaName: membership.hoaId.name,
    email: membership.email,
    expiresAt: membership.inviteTokenExpiresAt,
    accountExists: !!existingUser && !onboardingBlocked,
    hoaInfo: {
      communityName: membership.hoaId.name,
      numberOfUnits: membership.hoaId.numberOfUnits,
      associationType: membership.hoaId.associationType,
      propertyAddress: membership.hoaId.propertyAddress,
    },
  };
}

// Create a new HOA and make the creator an admin member
async function createHOA(userId, payload) {
  const body = payload && typeof payload === 'object' ? payload : { name: payload };
  const trimmed = validateHoaCommunityName(body.name);

  const propertyAddress = String(body.propertyAddress || '').trim();

  const associationType = body.associationType != null
    ? String(body.associationType).trim()
    : '';

  const user = await User.findById(userId).lean();
  const uInfo = user && user.hoaInfo ? user.hoaInfo : null;

  const hoaPayload = {
    name: trimmed,
    createdBy: userId,
    ...(propertyAddress ? { propertyAddress } : {}),
    ...(associationType ? { associationType } : {}),
  };

  if (uInfo && String(uInfo.communityName || '').trim() === trimmed) {
    if (uInfo.numberOfUnits != null && body.numberOfUnits == null) {
      hoaPayload.numberOfUnits = uInfo.numberOfUnits;
    }
    if (!associationType && uInfo.associationType) {
      hoaPayload.associationType = uInfo.associationType;
    }
    if (uInfo.hoaId) hoaPayload._id = uInfo.hoaId;
  }

  if (body.numberOfUnits != null && body.numberOfUnits !== '') {
    hoaPayload.numberOfUnits = validateHoaNumberOfUnits(body.numberOfUnits);
  }

  const existingActiveMemberships = await HOAMembership.countDocuments({ userId, status: 'active' });

  const hoa = await HOA.create(withNewHoaTrial(hoaPayload));
  notifyTrialStarted(hoa).catch(() => {});

  // Only sync hoaInfo for first-time community creators; invited members keep profile untouched.
  if (existingActiveMemberships === 0) {
    const profilePatch = {
      'hoaInfo.hoaId': hoa._id,
      'hoaInfo.communityName': trimmed,
    };
    if (propertyAddress) profilePatch['hoaInfo.propertyAddress'] = propertyAddress;
    if (associationType) profilePatch['hoaInfo.associationType'] = associationType;
    if (hoaPayload.numberOfUnits != null) profilePatch['hoaInfo.numberOfUnits'] = hoaPayload.numberOfUnits;
    await User.updateOne({ _id: userId }, { $set: profilePatch });
  }

  const memberEmail = resolveMembershipEmail({ email: user.email, userId: user });
  if (!memberEmail) throw new Error('User email is required to create board membership');

  await HOAMembership.create({
    hoaId: hoa._id,
    userId,
    email: memberEmail,
    role: 'admin',
    status: 'active',
    invitedBy: userId,
  });

  await logActivity({
    userId,
    action: 'CREATE',
    module: 'Settings',
    entityId: hoa._id,
    entityName: hoa.name,
    description: `HOA community "${hoa.name}" created.`,
  });

  return hoa;
}

/**
 * build Board Member Invite Role Conflict Error
 *
 * Performs logic operations for buildBoardMemberInviteRoleConflictError.
 *
 * @param roleName - Request/input argument
 * @returns Operations result
 */
function buildBoardMemberInviteRoleConflictError(roleName) {
  const normalizedRole = String(roleName || '').trim();
  const message =
    /^hoa owner$/i.test(normalizedRole)
      ? 'This user already has an HOA Owner account. You cannot send a Board Member invitation.'
      : `This user already has a ${normalizedRole} account. You cannot send a Board Member invitation.`;
  const err = new Error(message);
  err.status = 409;
  return err;
}

async function assertHoaInviteAdmin(hoaId, inviterUserId) {
  const inviterMembership = await HOAMembership.findOne({ hoaId, userId: inviterUserId, status: 'active' }).lean();
  if (!inviterMembership || inviterMembership.role !== 'admin') {
    const err = new Error('Only HOA admins can invite members');
    err.status = 403;
    throw err;
  }
}

/**
 * Ensure invitee email is eligible for a board-member invitation.
 * Allows: no account, or existing HOA Board Member accounts (re-invite / resend).
 * Blocks: HOA Owner and all other portal roles.
 */
async function validateBoardMemberInviteEmail(email) {
  const normalizedEmail = normalizeInviteEmail(email);
  const user = await User.findOne({ email: normalizedEmail, isDeleted: { $ne: true } })
    .select('companyId companyRoleId email')
    .lean();

  if (!user) {
    return { allowed: true, email: normalizedEmail, existingRole: null };
  }

  const roleName = await resolveUserRoleName(user);
  if (!roleName) {
    return { allowed: true, email: normalizedEmail, existingRole: null };
  }

  if (/^hoa board member$/i.test(roleName)) {
    return { allowed: true, email: normalizedEmail, existingRole: roleName };
  }

  throw buildBoardMemberInviteRoleConflictError(roleName);
}

/**
 * Roll back inviteMember when email delivery fails.
 * New memberships are deleted; existing rows are restored to their prior snapshot.
 */
async function rollbackFailedInviteDelivery(membershipId, priorMembership) {
  if (!membershipId) return;
  if (!priorMembership) {
    await HOAMembership.deleteOne({ _id: membershipId });
    return;
  }

  const restore = {
    status: priorMembership.status,
    invitedBy: priorMembership.invitedBy,
    role: priorMembership.role || 'member',
  };
  if (priorMembership.userId) restore.userId = priorMembership.userId;

  const update = { $set: restore };
  if (priorMembership.inviteToken) {
    update.$set.inviteToken = priorMembership.inviteToken;
    update.$set.inviteTokenExpiresAt = priorMembership.inviteTokenExpiresAt || null;
  } else {
    update.$unset = { inviteToken: '', inviteTokenExpiresAt: '' };
  }

  await HOAMembership.updateOne({ _id: membershipId }, update);
}

// Invite a board member by email to an HOA
async function inviteMember(hoaId, inviterUserId, email) {
  const normalizedEmail = normalizeInviteEmail(email);
  await validateBoardMemberInviteEmail(normalizedEmail);

  const hoa = await HOA.findById(hoaId).lean();
  if (!hoa) throw new Error('HOA not found');

  await assertHoaInviteAdmin(hoaId, inviterUserId);

  const inviter = await User.findById(inviterUserId).lean();
  const inviterName = inviter
    ? `${inviter.firstName || ''} ${inviter.lastName || ''}`.trim() || inviter.email
    : 'A board member';

  const existing = await HOAMembership.findOne({ hoaId, email: normalizedEmail }).lean();
  if (existing && existing.status === 'active') {
    const stillLive = await isActiveMembershipLinkedToLiveUser(existing);
    if (stillLive) throw new Error('User is already a member of this HOA');
  }

  const isResend = existing?.status === 'pending';
  const isReinvite = existing?.status === 'revoked';
  const priorMembership = existing
    ? {
      status: existing.status,
      invitedBy: existing.invitedBy,
      role: existing.role,
      userId: existing.userId || null,
      inviteToken: existing.inviteToken || null,
      inviteTokenExpiresAt: existing.inviteTokenExpiresAt || null,
    }
    : null;

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteTokenExpiresAt = DateUtil.fromEpoch(
    ClockService.nowEpoch() + getBoardInviteExpiryHours() * 60 * 60 * 1000
  );

  // Upsert: re-invite if previously revoked/pending
  const membership = await HOAMembership.findOneAndUpdate(
    { hoaId, email: normalizedEmail },
    {
      $set: {
        inviteToken,
        inviteTokenExpiresAt,
        status: 'pending',
        invitedBy: inviterUserId,
        role: 'member',
      },
    },
    { upsert: true, new: true }
  );

  const inviteeUser = await User.findOne({ email: normalizedEmail, isDeleted: { $ne: true } })
    .select('_id')
    .lean();
  if (inviteeUser?._id) {
    await clearBoardAccessBlocked(inviteeUser._id);
  }

  const inviteeLabel = normalizedEmail.split('@')[0];
  const description = isResend
    ? `Board member invitation resent to ${inviteeLabel}.`
    : `Board member invitation sent to ${inviteeLabel}.`;

  await logActivity({
    userId: inviterUserId,
    action: isResend ? 'UPDATE' : 'CREATE',
    module: 'Settings',
    entityId: membership._id,
    entityName: normalizedEmail,
    description,
  });

  return {
    membership,
    hoaName: hoa.name,
    inviteToken,
    inviterName,
    inviteeEmail: normalizedEmail,
    inviteeUserId: inviteeUser?._id || null,
    expiryHours: getBoardInviteExpiryHours(),
    isResend,
    isReinvite,
    priorMembership,
  };
}

// Accept an invite using the token - links the logged-in user to the HOA
async function acceptInvite(token, userId) {
  const rawToken = String(token || '').trim();
  if (!rawToken) throw new Error('Invalid or expired invite token');

  const pending = await HOAMembership.findOne({ inviteToken: rawToken, status: 'pending' }).lean();
  if (!pending) throw new Error('Invalid or expired invite token');
  if (!pending.inviteTokenExpiresAt || pending.inviteTokenExpiresAt < ClockService.now()) {
    throw new Error('Invite token has expired');
  }

  const user = await User.findById(userId).lean();
  if (!user) throw new Error('User not found');
  if (String(user.email).toLowerCase().trim() !== String(pending.email).toLowerCase().trim()) {
    throw new Error('This invite was sent to a different email address');
  }

  // Atomic accept + $unset so invite tokens cannot be reused (Mongoose strips `undefined` in updates).
  const membership = await HOAMembership.findOneAndUpdate(
    { _id: pending._id, inviteToken: rawToken, status: 'pending' },
    {
      $set: { userId, status: 'active' },
      $unset: { inviteToken: '', inviteTokenExpiresAt: '' },
    },
    { new: true }
  );
  if (!membership) {
    // Concurrent double-submit: the first request already activated this membership.
    const already = await HOAMembership.findOne({ _id: pending._id, userId, status: 'active' });
    if (already) return already;
    throw new Error('Invalid or expired invite token');
  }

  invalidateHoaCache(membership.hoaId);

  const hoa = await HOA.findById(membership.hoaId).lean();
  if (hoa) {
    // Sync hoaId + community info back to the invited member's profile
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          'hoaInfo.hoaId': hoa._id,
          'hoaInfo.communityName': hoa.name,
          ...(hoa.numberOfUnits != null ? { 'hoaInfo.numberOfUnits': hoa.numberOfUnits } : {}),
          ...(hoa.associationType ? { 'hoaInfo.associationType': hoa.associationType } : {}),
          ...(hoa.propertyAddress ? { 'hoaInfo.propertyAddress': hoa.propertyAddress } : {}),
        },
        $unset: { hoaBoardAccessBlocked: '' },
      }
    );
  } else {
    await clearBoardAccessBlocked(userId);
  }

  await logActivity({
    userId,
    action: 'UPDATE',
    module: 'Settings',
    entityId: membership._id,
    entityName: memberDisplayName(membership, user),
    description: `Board member invitation accepted by ${memberDisplayName(membership, user)}.`,
  });

  notifyBoardMemberInviteAcceptedInAppInBackground({
    hoaId: membership.hoaId,
    hoaName: hoa?.name || '',
    memberName: memberDisplayName(membership, user),
    invitedBy: pending.invitedBy,
    actorUserId: userId,
  });

  return membership;
}

/**
 * map Membership Row
 *
 * Performs logic operations for mapMembershipRow.
 *
 * @param m - Request/input argument
 * @returns Operations result
 */
function mapMembershipRow(m) {
  return {
    hoaId: String(m.hoaId._id),
    hoaName: m.hoaId.name,
    role: m.role,
    joinedAt: m.createdAt,
    numberOfUnits: m.hoaId.numberOfUnits,
    associationType: m.hoaId.associationType,
    propertyAddress: m.hoaId.propertyAddress,
    subscription: presentSubscription(m.hoaId),
  };
}

/**
 * map Hoa Profile Row
 *
 * Performs logic operations for mapHoaProfileRow.
 *
 * @param hoa - Request/input argument
 * @param role - Request/input argument
 * @returns Operations result
 */
function mapHoaProfileRow(hoa, role = 'member') {
  return {
    hoaId: String(hoa._id),
    hoaName: hoa.name,
    role,
    joinedAt: null,
    numberOfUnits: hoa.numberOfUnits,
    associationType: hoa.associationType,
    propertyAddress: hoa.propertyAddress,
    subscription: presentSubscription(hoa),
  };
}

async function resolveHoaFromUserProfile(user) {
  if (!user || !user.hoaInfo) return null;

  const info = user.hoaInfo;
  if (info.hoaId) {
    const byId = await HOA.findById(info.hoaId)
      .select(HOA_PROFILE_SELECT)
      .lean();
    if (byId) return byId;
  }

  const communityName = info.communityName ? String(info.communityName).trim() : '';
  if (!communityName) return null;

  return HOA.findOne({ name: communityName, isDeleted: { $ne: true } })
    .select(HOA_PROFILE_SELECT)
    .lean();
}

// Get all HOAs a user belongs to (for the switcher)
async function getUserHOAs(userId) {
  const { fetchUserWithResolvedRole } = require('../../../../../common/helpers/companyRoleHelper');

  // Run membership fetch and user/role resolution in parallel; ensurePrimary only needed when no active memberships
  const [memberships, { user, role }] = await Promise.all([
    HOAMembership.find({ userId, status: 'active' })
      .sort({ createdAt: 1 })
      .populate('hoaId', HOA_PROFILE_SELECT)
      .populate('userId', 'isDeleted')
      .lean(),
    fetchUserWithResolvedRole(userId, 'hoaInfo propertyIds role companyId companyRoleId associatedHoaIds hoaBoardAccessBlocked'),
  ]);

  // Exclude memberships where the user is missing, soft-deleted, or HOA was removed
  const validMemberships = memberships.filter((m) => m.userId && !m.userId.isDeleted && m.hoaId);

  if (validMemberships.length > 0) {
    return validMemberships.map(mapMembershipRow);
  }

  // Fast-path: block removed board access before doing expensive ensurePrimary
  const roleName = role?.name ? String(role.name) : '';
  if (/^hoa board member$/i.test(roleName)) {
    if (user?.hoaBoardAccessBlocked?.reason) {
      const err = new Error(
        buildAccessRemovedLoginMessage(
          user.hoaBoardAccessBlocked.hoaName,
          user.hoaBoardAccessBlocked.reason
        )
      );
      err.status = 403;
      throw err;
    }

    const revokedMembership = await HOAMembership.findOne({ userId, status: 'revoked' })
      .populate('hoaId', 'name')
      .sort({ updatedAt: -1 })
      .lean();
    if (revokedMembership) {
      const err = new Error(
        buildAccessRemovedLoginMessage(revokedMembership.hoaId?.name, 'revoked')
      );
      err.status = 403;
      throw err;
    }
  }

  // No active memberships - run ensure (may create HOA/membership) then re-check
  await ensurePrimaryHOAFromUserProfile(userId);
  const freshMemberships = await HOAMembership.find({ userId, status: 'active' })
    .sort({ createdAt: 1 })
    .populate('hoaId', HOA_PROFILE_SELECT)
    .populate('userId', 'isDeleted')
    .lean();
  const freshValid = freshMemberships.filter((m) => m.userId && !m.userId.isDeleted && m.hoaId);
  if (freshValid.length > 0) {
    return freshValid.map(mapMembershipRow);
  }

  // Vendors are not HOA members - resolve their associated HOAs from associatedHoaIds
  const { isVendorRole } = require('../../../../../common/helpers/hoaVendorRole');
  if (isVendorRole(roleName)) {
    const associatedHoaIds = Array.isArray(user?.associatedHoaIds)
      ? user.associatedHoaIds.filter(Boolean)
      : [];
    if (!associatedHoaIds.length) return [];
    const hoas = await HOA.find({ _id: { $in: associatedHoaIds }, isDeleted: { $ne: true } })
      .select(HOA_PROFILE_SELECT)
      .lean();
    return hoas.map((h) => mapHoaProfileRow(h, 'member'));
  }

  if (/^hoa board member$/i.test(roleName)) {
    const hoa = await resolveHoaFromUserProfile(user);
    if (hoa) {
      const membership = await HOAMembership.findOne({
        hoaId: hoa._id,
        userId,
        status: 'active',
      }).lean();
      return [mapHoaProfileRow(hoa, membership?.role || 'admin')];
    }

    return [];
  }

  // HOA Owners are not board members; they have no HOAMembership row. Resolve HOA from profile or linked units.
  if (!user || !/^hoa owner$/i.test(roleName)) {
    return [];
  }

  let hoaObjectId = user.hoaInfo && user.hoaInfo.hoaId ? user.hoaInfo.hoaId : null;
  if (!hoaObjectId && user.propertyIds && user.propertyIds.length > 0) {
    const prop = await Property.findById(user.propertyIds[0]).select('hoaId').lean();
    if (prop && prop.hoaId) hoaObjectId = prop.hoaId;
  }
  if (!hoaObjectId) {
    const hoa = await resolveHoaFromUserProfile(user);
    if (hoa) return [mapHoaProfileRow(hoa, 'member')];
    return [];
  }

  const hoa = await HOA.findById(hoaObjectId)
    .select(HOA_PROFILE_SELECT)
    .lean();
  if (!hoa) {
    return [];
  }

  return [mapHoaProfileRow(hoa, 'member')];
}

// Get all members of an HOA (for settings page)
async function getHOAMembers(hoaId, requestingUserId) {
  const requester = await HOAMembership.findOne({ hoaId, userId: requestingUserId, status: 'active' }).lean();
  if (!requester) throw new Error('Access denied');

  const membershipsRaw = await HOAMembership.find({ hoaId }).lean();
  const staleIds = await findStaleActiveMembershipIds(membershipsRaw);
  await revokeMembershipsByIds(staleIds);

  const memberships = await HOAMembership.find({ hoaId })
    .populate('userId', 'firstName lastName email profilePic isDeleted')
    .populate('invitedBy', 'firstName lastName email')
    .lean();

  return memberships.map((m) => {
    const email = resolveMembershipEmail(m);
    const storedEmail = m.email != null ? String(m.email).trim().toLowerCase() : '';
    if (email && storedEmail !== email) {
      HOAMembership.updateOne({ _id: m._id }, { $set: { email } }).catch(() => { });
    }
    return { ...m, email };
  });
}

// Revoke a member's access (active members only; record stays with status revoked)
async function revokeMember(hoaId, adminUserId, membershipId) {
  await assertActiveAdmin(hoaId, adminUserId);

  const target = await HOAMembership.findOne({ _id: membershipId, hoaId })
    .populate('userId', 'firstName lastName email')
    .populate('hoaId', 'name')
    .lean();
  if (!target) throw new Error('Membership not found');

  if (target.status === 'pending') {
    throw new Error('Use delete to cancel pending invitations');
  }
  if (target.status === 'revoked') {
    throw new Error('Member access is already revoked');
  }

  await assertNotLastActiveAdmin(hoaId, target);

  const membership = await HOAMembership.findOneAndUpdate(
    { _id: membershipId, hoaId },
    { $set: { status: 'revoked' }, $unset: { inviteToken: '', inviteTokenExpiresAt: '' } },
    { new: true }
  );

  const revokedUserId = target.userId?._id || target.userId;
  const hoaName = target.hoaId?.name || '';
  if (revokedUserId) {
    await handleBoardMemberAccessRemoved({
      userId: revokedUserId,
      hoaId,
      hoaName,
      reason: 'revoked',
      email: target.userId?.email || target.email,
      recipientName: memberDisplayName(target, target.userId),
    });
  }

  invalidateHoaCache(hoaId);

  await logActivity({
    userId: adminUserId,
    action: 'STATUS_CHANGE',
    module: 'Settings',
    entityId: membership._id,
    entityName: memberDisplayName(target, target.userId),
    description: 'Board member access revoked.',
    meta: { email: target.email },
  });

  const revokedName = memberDisplayName(target, target.userId);
  notifyBoardMemberUpdatedInAppInBackground({
    hoaId,
    memberName: revokedName,
    customMessage: `Board member "${revokedName}" access has been revoked.`,
    extraUserIds: revokedUserId ? [revokedUserId] : [],
    actorUserId: adminUserId,
  });

  return membership;
}

// Permanently remove a membership record from the HOA listing
async function deleteMember(hoaId, adminUserId, membershipId) {
  await assertActiveAdmin(hoaId, adminUserId);

  const target = await HOAMembership.findOne({ _id: membershipId, hoaId })
    .populate('userId', 'firstName lastName email')
    .populate('hoaId', 'name')
    .lean();
  if (!target) throw new Error('Membership not found');

  if (String(target.userId?._id || target.userId) === String(adminUserId)) {
    throw new Error('You cannot delete your own membership');
  }

  await assertNotLastActiveAdmin(hoaId, target);

  const removedUserId = target.userId?._id || target.userId;
  const hoaName = target.hoaId?.name || '';

  await HOAMembership.deleteOne({ _id: membershipId, hoaId });

  if (removedUserId || target.status === 'pending') {
    await handleBoardMemberAccessRemoved({
      userId: removedUserId || null,
      hoaId,
      hoaName,
      reason: 'deleted',
      email: target.userId?.email || target.email,
      recipientName: memberDisplayName(target, target.userId),
    });
  }

  invalidateHoaCache(hoaId);

  let description;
  if (target.status === 'pending') {
    description = `Board member invitation to ${memberDisplayName(target, target.userId)} cancelled.`;
  } else {
    description = `Board member ${memberDisplayName(target, target.userId)} deleted.`;
  }

  await logActivity({
    userId: adminUserId,
    action: 'DELETE',
    module: 'Settings',
    entityId: target._id,
    entityName: memberDisplayName(target, target.userId),
    description,
    meta: { email: target.email, priorStatus: target.status },
  });

  notifyBoardMemberDeletedInAppInBackground({
    hoaId,
    memberName: memberDisplayName(target, target.userId),
    deletedUserId: target.userId?._id || target.userId,
    actorUserId: adminUserId,
  });

  return { deleted: true, membershipId: target._id };
}

// Restore access for a previously revoked member
async function restoreMember(hoaId, adminUserId, membershipId) {
  await assertActiveAdmin(hoaId, adminUserId);

  const target = await HOAMembership.findOne({ _id: membershipId, hoaId })
    .populate('userId', 'firstName lastName email isDeleted')
    .lean();
  if (!target) throw new Error('Membership not found');

  if (target.status !== 'revoked') {
    throw new Error('Only revoked members can be restored');
  }
  if (!target.userId || target.userId.isDeleted) {
    throw new Error('Cannot restore access because the user account is no longer available');
  }

  const membership = await HOAMembership.findOneAndUpdate(
    { _id: membershipId, hoaId },
    { $set: { status: 'active' }, $unset: { inviteToken: '', inviteTokenExpiresAt: '' } },
    { new: true }
  );

  const restoredUserId = target.userId?._id || target.userId;
  if (restoredUserId) {
    await clearBoardAccessBlocked(restoredUserId);
  }

  invalidateHoaCache(hoaId);

  await logActivity({
    userId: adminUserId,
    action: 'RESTORE',
    module: 'Settings',
    entityId: membership._id,
    entityName: memberDisplayName(target, target.userId),
    description: 'Board member access restored.',
    meta: { email: target.email },
  });

  const restoredName = memberDisplayName(target, target.userId);
  notifyBoardMemberUpdatedInAppInBackground({
    hoaId,
    memberName: restoredName,
    customMessage: `Board member "${restoredName}" access has been restored.`,
    extraUserIds: (target.userId?._id || target.userId) ? [target.userId._id || target.userId] : [],
    actorUserId: adminUserId,
  });

  return membership;
}

// Update HOA community profile fields
async function updateHOAProfile(hoaId, adminUserId, payload) {
  await assertActiveAdmin(hoaId, adminUserId);

  const hoa = await HOA.findById(hoaId);
  if (!hoa) throw new Error('HOA not found');

  const updates = {};
  const activityMessages = [];

  if (payload.name !== undefined) {
    const nextName = validateHoaCommunityName(payload.name);
    if (nextName !== String(hoa.name || '').trim()) {
      updates.name = nextName;
      activityMessages.push('Community name updated.');
    }
  }

  if (payload.numberOfUnits !== undefined) {
    const nextUnits = validateHoaNumberOfUnits(payload.numberOfUnits);
    const currentUnits = hoa.numberOfUnits != null ? Number(hoa.numberOfUnits) : null;
    if (currentUnits !== nextUnits) {
      const existingUnits = await countExistingHoaUnits(hoaId);
      if (nextUnits < existingUnits) {
        throw new Error(
          `Number of units cannot be less than existing units in this community (${existingUnits})`
        );
      }
      updates.numberOfUnits = nextUnits;
      activityMessages.push('Number of units updated.');
    }
  }

  if (payload.propertyAddress !== undefined) {
    const nextAddress = String(payload.propertyAddress || '').trim();
    if (nextAddress !== String(hoa.propertyAddress || '').trim()) {
      updates.propertyAddress = nextAddress;
      activityMessages.push('Community address updated.');
    }
  }

  if (payload.associationType !== undefined) {
    const nextType = String(payload.associationType || '').trim();
    if (nextType !== String(hoa.associationType || '').trim()) {
      updates.associationType = nextType;
      activityMessages.push('Association type updated.');
    }
  }

  if (!Object.keys(updates).length) {
    return hoa.toObject();
  }

  Object.assign(hoa, updates);
  await hoa.save();
  await syncHoaInfoToMembers(hoaId, hoa);

  for (const description of activityMessages) {
    await logActivity({
      userId: adminUserId,
      action: 'UPDATE',
      module: 'Settings',
      entityId: hoa._id,
      entityName: hoa.name,
      description,
      meta: updates,
    });
  }

  return hoa.toObject();
}

async function convertHoaToSubscription(hoaId, adminUserId) {
  await assertActiveAdmin(hoaId, adminUserId);
  const existing = await HOA.findOne({ _id: hoaId, isDeleted: { $ne: true } });
  if (!existing) throw new Error('HOA not found');
  if (!existing.trialStartAt && !existing.trialStatus) {
    throw new Error('This community is not on a trial plan');
  }
  existing.set(subscribedPatch());
  await existing.save();
  return {
    hoaId: String(existing._id),
    subscription: presentSubscription(existing.toObject()),
  };
}

async function getHoaSubscriptionForMember(userId, hoaIdParam) {
  const hoaId = hoaIdParam || null;
  let hoa = null;
  if (hoaId) {
    const membership = await HOAMembership.findOne({ hoaId, userId, status: 'active' }).lean();
    if (!membership) throw new Error('Access denied');
    hoa = await HOA.findOne({ _id: hoaId, isDeleted: { $ne: true } }).select(HOA_PROFILE_SELECT).lean();
  } else {
    const membership = await HOAMembership.findOne({ userId, status: 'active' })
      .sort({ createdAt: 1 })
      .populate('hoaId', HOA_PROFILE_SELECT)
      .lean();
    hoa = membership?.hoaId || null;
  }
  if (!hoa) throw new Error('HOA not found');
  return presentSubscription(hoa);
}

async function getCommunityOnboardingStatusForMember(userId, hoaIdParam, hoaContext) {
  return getCommunityOnboardingStatus(userId, hoaIdParam, hoaContext);
}

module.exports = {
  createHOA,
  assertHoaInviteAdmin,
  buildBoardMemberInviteRoleConflictError,
  validateBoardMemberInviteEmail,
  inviteMember,
  acceptInvite,
  rollbackFailedInviteDelivery,
  getUserHOAs,
  getHOAMembers,
  revokeMember,
  deleteMember,
  restoreMember,
  updateHOAProfile,
  ensurePrimaryHOAFromUserProfile,
  getInvitePreview,
  getBoardInviteExpiryHours,
  getCommunityOnboardingStatusForMember,
  convertHoaToSubscription,
  getHoaSubscriptionForMember,
};