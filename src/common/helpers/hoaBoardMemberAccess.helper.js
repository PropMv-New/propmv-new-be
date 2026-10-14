const User = require('../../shared/modules/users/models/user.model');
const HOA = require('../../portals/hoa-board/modules/hoa/model/hoa.model');
const HOAMembership = require('../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const emailHelper = require('./emailHelper');
const { fetchUserWithResolvedRole } = require('./companyRoleHelper');
const { ClockService } = require('../date');
const { buildCommunityEmailSubject } = require('./communityEmailContext.service');
const logger = require('../logger');

function buildAccessRemovedLoginMessage(hoaName, reason) {
  const community = hoaName || 'your HOA';
  if (reason === 'revoked') {
    return `You are no longer an HOA board member. Your access to ${community} has been revoked. Reach out to an HOA board member to reactivate your account.`;
  }
  return `You are no longer an HOA board member. Your access to ${community} has been deleted. Reach out to an HOA board member to reactivate your account.`;
}

function buildAccessRemovedEmailCopy(reason) {
  if (reason === 'revoked') {
    return {
      headline: 'Your HOA board access has been revoked',
      introParagraph:
        'Your HOA board member access has been revoked. You can no longer sign in to this community until an HOA board member restores your access.',
    };
  }
  return {
    headline: 'Your HOA board access has been removed',
    introParagraph:
      'Your HOA board member access has been deleted. You can no longer sign in to this community until an HOA board member re-invites you.',
  };
}

/**
 * Block login when an HOA board member has no remaining active community access.
 */
async function hasValidPendingBoardInvite({ userId, email }) {
  const now = ClockService.now();
  const inviteFilters = [{ userId }];
  const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
  if (normalizedEmail) inviteFilters.push({ email: normalizedEmail });

  return HOAMembership.exists({
    status: 'pending',
    inviteToken: { $exists: true, $nin: [null, ''] },
    inviteTokenExpiresAt: { $gt: now },
    $or: inviteFilters,
  });
}

async function assertHoaBoardMemberCanAuthenticate(userId) {
  const [{ user, role }, activeCount] = await Promise.all([
    fetchUserWithResolvedRole(userId, 'hoaInfo companyId companyRoleId hoaBoardAccessBlocked email'),
    HOAMembership.countDocuments({ userId, status: 'active' }),
  ]);

  const roleName = role?.name ? String(role.name) : '';
  if (!/^hoa board member$/i.test(roleName)) return;
  if (activeCount > 0) return;

  const blocked = user?.hoaBoardAccessBlocked;
  if (blocked?.hoaName || blocked?.reason) {
    const err = new Error(buildAccessRemovedLoginMessage(blocked.hoaName, blocked.reason || 'deleted'));
    err.status = 403;
    err.code = blocked.reason === 'revoked' ? 'HOA_BOARD_ACCESS_REVOKED' : 'HOA_BOARD_ACCESS_REMOVED';
    throw err;
  }

  const revokedMembership = await HOAMembership.findOne({ userId, status: 'revoked' })
    .populate('hoaId', 'name')
    .sort({ updatedAt: -1 })
    .lean();
  if (revokedMembership) {
    const hoaName = revokedMembership.hoaId?.name || '';
    const err = new Error(buildAccessRemovedLoginMessage(hoaName, 'revoked'));
    err.status = 403;
    err.code = 'HOA_BOARD_ACCESS_REVOKED';
    throw err;
  }

  // Invite onboarding: email verification / login happen before accept-invite links userId.
  if (await hasValidPendingBoardInvite({ userId, email: user?.email })) return;

  const info = user?.hoaInfo;
  const hasProvisionProfile = !!(info?.communityName || info?.hoaId);
  if (hasProvisionProfile) return;

  const err = new Error(
    'You are no longer an HOA board member. Your board access has been removed. Reach out to an HOA board member to reactivate your account.'
  );
  err.status = 403;
  err.code = 'HOA_BOARD_ACCESS_REMOVED';
  throw err;
}

async function clearUserHoaInfoForHoa(userId, hoaId) {
  const user = await User.findById(userId).select('hoaInfo').lean();
  if (!user?.hoaInfo) return;
  if (String(user.hoaInfo.hoaId || '') !== String(hoaId)) return;

  await User.updateOne(
    { _id: userId },
    {
      $unset: {
        'hoaInfo.hoaId': '',
        'hoaInfo.communityName': '',
        'hoaInfo.numberOfUnits': '',
        'hoaInfo.propertyAddress': '',
        'hoaInfo.associationType': '',
      },
    }
  );
}

async function setBoardAccessBlocked(userId, { hoaName, reason }) {
  if (!userId) return;
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        hoaBoardAccessBlocked: {
          hoaName: hoaName || '',
          reason: reason === 'revoked' ? 'revoked' : 'deleted',
          blockedAt: ClockService.now(),
        },
      },
    }
  );
}

async function clearBoardAccessBlocked(userId) {
  if (!userId) return;
  await User.updateOne({ _id: userId }, { $unset: { hoaBoardAccessBlocked: '' } });
}

async function terminateBoardMemberSessions(userId, reason = 'access_revoked') {
  if (!userId) return;

  await User.updateOne(
    { _id: userId },
    {
      $unset: { refreshToken: '' },
      $set: { credentialsChangedAt: ClockService.now() },
    }
  );

  try {
    const websocketManager = require('../../shared/messaging/service/websocket.manager');
    websocketManager.emitToUser?.(userId, 'auth_force_logout', {
      reason: reason === 'deleted' ? 'access_removed' : 'access_revoked',
    });
  } catch (err) {
    logger.warn('[hoaBoardMemberAccess] Failed to emit force logout', { error: err?.message || err });
  }
}

async function sendBoardMemberAccessRemovedEmail({
  email,
  recipientName,
  hoaName,
  reason = 'revoked',
  hoaId = null,
}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) return;

  const copy = buildAccessRemovedEmailCopy(reason);
  const loginUrl =
    process.env.HOA_FRONTEND_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.INVITE_ACCEPT_URL ||
    process.env.FRONTEND_APP_URL ||
    'https://www.google.com';

  const baseSubject =
    reason === 'revoked'
      ? 'Your HOA board member access has been revoked'
      : 'Your HOA board member access has been removed';

  await emailHelper.sendEmail(
    'hoa-board-access-removed',
    normalizedEmail,
    {
      recipientName: recipientName || normalizedEmail.split('@')[0] || 'there',
      hoaName: hoaName || 'your HOA',
      headline: copy.headline,
      introParagraph: copy.introParagraph,
      supportParagraph:
        'If you believe this was a mistake, contact an HOA board member to restore your access.',
      loginUrl,
    },
    {
      template: 'hoa-board-access-removed',
      subject: buildCommunityEmailSubject(baseSubject, hoaName),
      preheaderText: copy.headline,
      hoaId,
      communityName: hoaName || null,
    }
  );
}

function sendBoardMemberAccessRemovedEmailInBackground(payload) {
  setImmediate(() => {
    sendBoardMemberAccessRemovedEmail(payload).catch((err) => {
      logger.warn('[hoaBoardMemberAccess] Failed to send access removed email', {
        error: err?.message || err,
        email: payload?.email,
      });
    });
  });
}

async function resolveUserIdFromInviteEmail(userId, email) {
  if (userId) return userId;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const user = await User.findOne({ email: normalizedEmail, isDeleted: { $ne: true } }).select('_id').lean();
  return user?._id || null;
}

/**
 * After revoke/delete, sync profile, optionally block login, terminate sessions, and email.
 */
async function handleBoardMemberAccessRemoved({
  userId,
  hoaId,
  hoaName,
  reason,
  email,
  recipientName,
}) {
  const resolvedHoaName =
    hoaName ||
    (hoaId ? (await HOA.findById(hoaId).select('name').lean())?.name : '') ||
    '';

  const resolvedUserId = await resolveUserIdFromInviteEmail(userId, email);

  if (resolvedUserId) {
    await clearUserHoaInfoForHoa(resolvedUserId, hoaId);

    const remainingActive = await HOAMembership.countDocuments({ userId: resolvedUserId, status: 'active' });
    if (remainingActive === 0) {
      await setBoardAccessBlocked(resolvedUserId, { hoaName: resolvedHoaName, reason });
      await terminateBoardMemberSessions(resolvedUserId, reason);
    }
  }

  const recipientEmail =
    email ||
    (resolvedUserId ? (await User.findById(resolvedUserId).select('email firstName lastName').lean())?.email : '');
  let resolvedRecipientName = recipientName;
  if (!resolvedRecipientName && resolvedUserId) {
    const user = await User.findById(resolvedUserId).select('firstName lastName email').lean();
    resolvedRecipientName =
      `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email?.split('@')[0] || 'there';
  }

  if (recipientEmail) {
    sendBoardMemberAccessRemovedEmailInBackground({
      email: recipientEmail,
      recipientName: resolvedRecipientName,
      hoaName: resolvedHoaName,
      reason,
      hoaId,
    });
  }
}

module.exports = {
  assertHoaBoardMemberCanAuthenticate,
  buildAccessRemovedLoginMessage,
  clearBoardAccessBlocked,
  clearUserHoaInfoForHoa,
  handleBoardMemberAccessRemoved,
  sendBoardMemberAccessRemovedEmail,
  terminateBoardMemberSessions,
};
