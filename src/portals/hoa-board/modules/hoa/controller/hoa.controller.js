/**
 * ------------------------------------------------------------------
 * File: hoa.controller.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * hoa.routes
 * ------------------------------------------------------------------
 */

const hoaService = require('../service/hoa.service');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const emailHelper = require('../../../../../common/helpers/emailHelper');
const { logInviteUrl } = require('../../../../../common/helpers/inviteLinkLogger');
const { logControllerStep, handleControllerError } = require('../../../../../common/helpers/controllerLogger');
const {
  notifyBoardMemberInvitedInAppInBackground,
} = require('../../../../../common/helpers/hoaCommunityNotify.helper');

/**
 * resolve Hoa Frontend Base Url
 *
 * Performs logic operations for resolveHoaFrontendBaseUrl.
 *
 * @returns Operations result
 */
function resolveHoaFrontendBaseUrl() {
  const base =
    process.env.HOA_FRONTEND_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.INVITE_ACCEPT_URL ||
    process.env.FRONTEND_APP_URL ||
    '';
  return String(base).replace(/\/$/, '');
}

/** Public: invitation email landing page (no auth). */
const invitePreview = async (req, res) => {
  logControllerStep(req, 'START', { action: 'invitePreview' });
  try {
    const token = req.query.token;
    if (!token || !String(token).trim()) {
      return responseHelper.error(res, 'Invitation token is required', 400);
    }
    const preview = await hoaService.getInvitePreview(String(token).trim());
    return responseHelper.success(res, preview, 'OK', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const createHOA = async (req, res) => {
  logControllerStep(req, 'START', { action: 'createHOA' });
  try {
    const userId = req.userId || req.user?._id;
    const { name, propertyAddress, associationType, numberOfUnits } = req.body;
    const hoa = await hoaService.createHOA(userId, {
      name,
      propertyAddress,
      associationType,
      numberOfUnits,
    });
    return responseHelper.success(res, hoa, 'HOA created', 201);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const inviteMember = async (req, res) => {
  logControllerStep(req, 'START', { action: 'inviteMember' });
  let result;
  try {
    const userId = req.userId || req.user?._id;
    const { hoaId } = req.params;
    const { email } = req.body;
    result = await hoaService.inviteMember(hoaId, userId, email);

    const frontendBase = resolveHoaFrontendBaseUrl();
    if (!frontendBase) {
      await hoaService.rollbackFailedInviteDelivery(result.membership._id, result.priorMembership);
      return responseHelper.error(
        res,
        'Server misconfiguration: set HOA_FRONTEND_BASE_URL or FRONTEND_BASE_URL so invitation links can be emailed.',
        500
      );
    }

    const inviteUrl = `${frontendBase}/hoa/accept-board-invite?token=${encodeURIComponent(result.inviteToken)}`;
    const recipientName = result.inviteeEmail.split('@')[0];

    logInviteUrl({
      kind: 'HOA Board Member Invitation',
      email: result.inviteeEmail,
      url: inviteUrl,
      template: 'hoa-board-invite',
      meta: {
        hoa: result.hoaName,
        expires: `${result.expiryHours} hours`,
      },
    });

    try {
      await emailHelper.sendEmail(
        'hoa-board-invite',
        result.inviteeEmail,
        {
          recipientName,
          inviterName: result.inviterName,
          hoaName: result.hoaName,
          inviteUrl,
          expiryHours: result.expiryHours,
        },
        {
          template: 'hoa-board-invite',
          subject: `You're invited to ${result.hoaName} on PropMv`,
          hoaId,
          senderUserId: userId,
          communityName: result.hoaName,
        }
      );
    } catch (emailErr) {
      await hoaService.rollbackFailedInviteDelivery(result.membership._id, result.priorMembership);
      return responseHelper.error(
        res,
        emailErr.message || 'Failed to send invitation email. Check SMTP settings.',
        502
      );
    }

    // Notify existing board members (and the invitee if they already have an account)
    const inviteeLabel = result.inviteeEmail.split('@')[0];
    notifyBoardMemberInvitedInAppInBackground({
      hoaId,
      hoaName: result.hoaName,
      memberName: inviteeLabel,
      isResend: Boolean(result.isResend),
      inviteeUserId: result.inviteeUserId,
      actorUserId: userId,
    });

    return responseHelper.success(
      res,
      {
        membershipId: result.membership._id,
        email: result.inviteeEmail,
        inviteExpiresAt: result.membership.inviteTokenExpiresAt,
        expiresInHours: result.expiryHours,
      },
      'Invitation email sent',
      200
    );
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 400);
  }
};

const validateInvite = async (req, res) => {
  logControllerStep(req, 'START', { action: 'validateInvite' });
  try {
    const userId = req.userId || req.user?._id;
    const { hoaId } = req.params;
    const { email } = req.query;
    await hoaService.assertHoaInviteAdmin(hoaId, userId);
    const result = await hoaService.validateBoardMemberInviteEmail(email);
    return responseHelper.success(res, result, 'Invite email is eligible', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 400);
  }
};

const acceptInvite = async (req, res) => {
  logControllerStep(req, 'START', { action: 'acceptInvite' });
  try {
    const userId = req.userId || req.user?._id;
    const { token } = req.body;
    const membership = await hoaService.acceptInvite(token, userId);
    return responseHelper.success(res, membership, 'Invite accepted', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const getMyHOAs = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getMyHOAs' });
  try {
    const userId = req.userId || req.user?._id;
    const hoas = await hoaService.getUserHOAs(userId);
    return responseHelper.success(res, hoas, 'HOAs fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 400);
  }
};

const getInviteConfig = (req, res) => {
  return responseHelper.success(
    res,
    { inviteExpiryHours: hoaService.getBoardInviteExpiryHours() },
    'OK',
    200
  );
};

const getHOAMembers = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getHOAMembers' });
  try {
    const userId = req.userId || req.user?._id;
    const { hoaId } = req.params;
    const members = await hoaService.getHOAMembers(hoaId, userId);
    return responseHelper.success(res, members, 'Members fetched', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const revokeMember = async (req, res) => {
  logControllerStep(req, 'START', { action: 'revokeMember' });
  try {
    const userId = req.userId || req.user?._id;
    const { hoaId, membershipId } = req.params;
    const result = await hoaService.revokeMember(hoaId, userId, membershipId);
    return responseHelper.success(res, result, 'Member access revoked', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const deleteMember = async (req, res) => {
  logControllerStep(req, 'START', { action: 'deleteMember' });
  try {
    const userId = req.userId || req.user?._id;
    const { hoaId, membershipId } = req.params;
    const result = await hoaService.deleteMember(hoaId, userId, membershipId);
    return responseHelper.success(res, result, 'Member deleted', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const restoreMember = async (req, res) => {
  logControllerStep(req, 'START', { action: 'restoreMember' });
  try {
    const userId = req.userId || req.user?._id;
    const { hoaId, membershipId } = req.params;
    const result = await hoaService.restoreMember(hoaId, userId, membershipId);
    return responseHelper.success(res, result, 'Member access restored', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const updateHOAProfile = async (req, res) => {
  logControllerStep(req, 'START', { action: 'updateHOAProfile' });
  try {
    const userId = req.userId || req.user?._id;
    const { hoaId } = req.params;
    const { propertyAddress, associationType, name, numberOfUnits } = req.body;
    const result = await hoaService.updateHOAProfile(hoaId, userId, {
      name,
      numberOfUnits,
      propertyAddress,
      associationType,
    });
    return responseHelper.success(res, result, 'Community profile updated', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, 400);
  }
};

const getOnboardingStatus = async (req, res) => {
  logControllerStep(req, 'START', { action: 'getOnboardingStatus' });
  try {
    const userId = req.userId || req.user?._id;
    const hoaIdParam = req.headers['x-hoa-id'] || req.query.hoaId || null;
    const status = await hoaService.getCommunityOnboardingStatusForMember(
      userId,
      hoaIdParam,
      req.hoaContext
    );
    return responseHelper.success(res, status, 'OK', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 400);
  }
};

const getSubscription = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const hoaIdParam = req.headers['x-hoa-id'] || req.query.hoaId || null;
    const subscription = await hoaService.getHoaSubscriptionForMember(userId, hoaIdParam);
    return responseHelper.success(res, subscription, 'OK', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 400);
  }
};

const subscribe = async (req, res) => {
  try {
    const userId = req.userId || req.user?._id;
    const result = await hoaService.convertHoaToSubscription(req.params.hoaId, userId);
    return responseHelper.success(res, result, 'Subscription activated', 200);
  } catch (err) {
    return responseHelper.error(res, err.message, err.status || 400);
  }
};

module.exports = {
  invitePreview,
  getInviteConfig,
  createHOA,
  validateInvite,
  inviteMember,
  acceptInvite,
  getMyHOAs,
  getHOAMembers,
  revokeMember,
  deleteMember,
  restoreMember,
  updateHOAProfile,
  getOnboardingStatus,
  getSubscription,
  subscribe,
};
