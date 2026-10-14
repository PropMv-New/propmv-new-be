/**
 * Community-level HOA in-app notifications: fee settings and board membership.
 */

const HOAMembership = require('../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const { EVENTS } = require('../notifications');
const {
  toIdString,
  dedupeIds,
  resolveBoardMemberIds,
} = require('./hoaRecipientResolver');
const {
  runHoaNotifyInBackground,
  dispatchHoaInAppNotification,
} = require('./hoaNotifyDispatch.helper');
const logger = require('../logger');

function buildMetadata(hoaId, extra = {}) {
  return {
    hoaId: hoaId ? String(hoaId) : undefined,
    ...extra,
  };
}

async function dispatchToBoard({
  hoaId,
  event,
  data = {},
  extraUserIds = [],
  metadata = {},
  idempotencyKey,
}) {
  const resolvedHoaId = toIdString(hoaId);
  if (!resolvedHoaId || !event) return { sent: 0 };

  const boardIds = await resolveBoardMemberIds(resolvedHoaId);
  const recipients = dedupeIds([...boardIds, ...extraUserIds]);
  if (!recipients.length) return { sent: 0 };

  await dispatchHoaInAppNotification(
    event,
    data,
    recipients,
    buildMetadata(resolvedHoaId, metadata),
    { idempotencyKey }
  );
  return { sent: recipients.length };
}

async function notifyHoaFeeUpdatedInApp({
  hoaId,
  hoaName = '',
  customMessage = '',
  actorUserId = null,
} = {}) {
  try {
    const resolvedHoaId = toIdString(hoaId);
    return await dispatchToBoard({
      hoaId: resolvedHoaId,
      event: EVENTS.HOA_FEE_UPDATED,
      data: { hoaName, customMessage: customMessage || undefined },
      extraUserIds: actorUserId ? [actorUserId] : [],
      metadata: { entityType: 'hoa_settings', entityId: resolvedHoaId },
      idempotencyKey: `hoa_fee_updated:${resolvedHoaId}:${Date.now()}`,
    });
  } catch (err) {
    logger.error('notifyHoaFeeUpdatedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyHoaFeeUpdatedInAppInBackground(payload) {
  runHoaNotifyInBackground(
    () => notifyHoaFeeUpdatedInApp(payload),
    'hoa fee updated notify'
  );
}

async function notifyBoardMemberUpdatedInApp({
  hoaId,
  memberName = 'Board member',
  customMessage = '',
  extraUserIds = [],
  actorUserId = null,
} = {}) {
  try {
    const resolvedHoaId = toIdString(hoaId);
    return await dispatchToBoard({
      hoaId: resolvedHoaId,
      event: EVENTS.BOARD_MEMBER_UPDATED,
      data: { memberName, customMessage: customMessage || undefined },
      extraUserIds: [...extraUserIds, actorUserId].filter(Boolean),
      metadata: { entityType: 'board_member' },
      idempotencyKey: `board_member_updated:${resolvedHoaId}:${toIdString(actorUserId)}:${Date.now()}`,
    });
  } catch (err) {
    logger.error('notifyBoardMemberUpdatedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyBoardMemberUpdatedInAppInBackground(payload) {
  runHoaNotifyInBackground(
    () => notifyBoardMemberUpdatedInApp(payload),
    'board member updated notify'
  );
}

async function notifyBoardMemberDeletedInApp({
  hoaId,
  memberName = 'Board member',
  deletedUserId = null,
  actorUserId = null,
} = {}) {
  try {
    const resolvedHoaId = toIdString(hoaId);
    return await dispatchToBoard({
      hoaId: resolvedHoaId,
      event: EVENTS.BOARD_MEMBER_DELETED,
      data: { memberName },
      extraUserIds: [deletedUserId, actorUserId].filter(Boolean),
      metadata: {
        entityType: 'board_member',
        entityId: toIdString(deletedUserId) || undefined,
      },
      idempotencyKey: `board_member_deleted:${resolvedHoaId}:${toIdString(deletedUserId) || memberName}:${Date.now()}`,
    });
  } catch (err) {
    logger.error('notifyBoardMemberDeletedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyBoardMemberDeletedInAppInBackground(payload) {
  runHoaNotifyInBackground(
    () => notifyBoardMemberDeletedInApp(payload),
    'board member deleted notify'
  );
}

async function notifyBoardMemberInvitedInApp({
  hoaId,
  hoaName = '',
  memberName = 'A board member',
  customMessage = '',
  isResend = false,
  inviteeUserId = null,
  actorUserId = null,
} = {}) {
  try {
    const resolvedHoaId = toIdString(hoaId);
    return await dispatchToBoard({
      hoaId: resolvedHoaId,
      event: EVENTS.BOARD_MEMBER_INVITED,
      data: {
        memberName,
        hoaName,
        isResend: Boolean(isResend),
        customMessage: customMessage || undefined,
      },
      // Existing board members + inviter + invitee (when they already have an account).
      extraUserIds: [inviteeUserId, actorUserId].filter(Boolean),
      metadata: {
        entityType: 'board_member',
        entityId: toIdString(inviteeUserId) || undefined,
      },
      idempotencyKey: `board_member_invited:${resolvedHoaId}:${toIdString(actorUserId)}:${Date.now()}`,
    });
  } catch (err) {
    logger.error('notifyBoardMemberInvitedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyBoardMemberInvitedInAppInBackground(payload) {
  runHoaNotifyInBackground(
    () => notifyBoardMemberInvitedInApp(payload),
    'board member invited notify'
  );
}

async function notifyBoardMemberInviteAcceptedInApp({
  hoaId,
  hoaName = '',
  memberName = 'A board member',
  invitedBy = null,
  actorUserId = null,
} = {}) {
  try {
    const resolvedHoaId = toIdString(hoaId);
    return await dispatchToBoard({
      hoaId: resolvedHoaId,
      event: EVENTS.BOARD_MEMBER_INVITE_ACCEPTED,
      data: { memberName, hoaName },
      extraUserIds: [invitedBy, actorUserId].filter(Boolean),
      metadata: { entityType: 'board_member', entityId: toIdString(actorUserId) || undefined },
      idempotencyKey: `board_member_invite_accepted:${resolvedHoaId}:${toIdString(actorUserId)}:${Date.now()}`,
    });
  } catch (err) {
    logger.error('notifyBoardMemberInviteAcceptedInApp failed', err);
    return { sent: 0 };
  }
}

function notifyBoardMemberInviteAcceptedInAppInBackground(payload) {
  runHoaNotifyInBackground(
    () => notifyBoardMemberInviteAcceptedInApp(payload),
    'board member invite accepted notify'
  );
}

async function resolveSharedBoardHoaId(actorUserId, targetUserId, hoaIdHint = null) {
  const actorId = toIdString(actorUserId);
  const targetId = toIdString(targetUserId);
  if (!actorId || !targetId || actorId === targetId) return '';

  if (hoaIdHint) {
    const rows = await HOAMembership.find({
      hoaId: hoaIdHint,
      userId: { $in: [actorId, targetId] },
      status: 'active',
    })
      .select('userId')
      .lean();
    const ids = new Set(rows.map((r) => toIdString(r.userId)));
    if (ids.has(actorId) && ids.has(targetId)) return toIdString(hoaIdHint);
  }

  const actorMemberships = await HOAMembership.find({
    userId: actorId,
    status: 'active',
  })
    .select('hoaId')
    .lean();
  const hoaIds = actorMemberships.map((m) => m.hoaId).filter(Boolean);
  if (!hoaIds.length) return '';

  const shared = await HOAMembership.findOne({
    userId: targetId,
    status: 'active',
    hoaId: { $in: hoaIds },
  })
    .select('hoaId')
    .lean();
  return shared?.hoaId ? toIdString(shared.hoaId) : '';
}

function notifyBoardMemberProfileUpdatedIfApplicable(actorUserId, targetUser, hoaIdHint = null) {
  const targetId = toIdString(targetUser?._id || targetUser);
  const actorId = toIdString(actorUserId);
  if (!actorId || !targetId || actorId === targetId) return;

  runHoaNotifyInBackground(async () => {
    const hoaId = await resolveSharedBoardHoaId(actorId, targetId, hoaIdHint);
    if (!hoaId) return;
    const memberName = `${targetUser?.firstName || ''} ${targetUser?.lastName || ''}`.trim()
      || targetUser?.email
      || 'Board member';
    await notifyBoardMemberUpdatedInApp({
      hoaId,
      memberName,
      customMessage: `Board member "${memberName}" profile has been updated.`,
      extraUserIds: [targetId],
      actorUserId: actorId,
    });
  }, 'board member profile updated notify');
}

module.exports = {
  notifyHoaFeeUpdatedInApp,
  notifyHoaFeeUpdatedInAppInBackground,
  notifyBoardMemberUpdatedInApp,
  notifyBoardMemberUpdatedInAppInBackground,
  notifyBoardMemberDeletedInApp,
  notifyBoardMemberDeletedInAppInBackground,
  notifyBoardMemberInvitedInApp,
  notifyBoardMemberInvitedInAppInBackground,
  notifyBoardMemberInviteAcceptedInApp,
  notifyBoardMemberInviteAcceptedInAppInBackground,
  notifyBoardMemberProfileUpdatedIfApplicable,
  resolveSharedBoardHoaId,
};
