'use strict';

const HOA = require('../portals/hoa-board/modules/hoa/model/hoa.model');
const { isHOABoardMemberRole } = require('../common/helpers/hoaBoardRole');
const { getHoaSubscriptionStatus } = require('../portals/hoa-board/modules/hoa/service/hoaSubscription.service');
const responseHelper = require('../common/helpers/responseHelper');

const EXPIRED_MESSAGE = 'Your free trial has ended. Please subscribe to continue using PropMv.';

function requestPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}`;
}

function isAllowlisted(req) {
  const path = requestPath(req);
  const method = String(req.method || 'GET').toUpperCase();
  if (path.includes('/users')) return true;
  if (method === 'GET' && (
    path.endsWith('/my-hoas')
    || path.endsWith('/subscription')
    || path.endsWith('/invite-preview')
    || path.endsWith('/invite-config')
    || path.endsWith('/onboarding-status')
  )) return true;
  if (method === 'POST' && /\/subscribe\/?$/.test(path)) return true;
  if (method === 'POST' && /\/board-members\/?$/.test(path)) return true;
  if (method === 'POST' && path.includes('/accept-invite')) return true;
  return false;
}

async function resolveHoaId(req) {
  const fromContext = req.hoaContext?.hoaId;
  if (fromContext) return String(fromContext);
  const header = req.headers?.['x-hoa-id'];
  if (header) return String(header);
  if (req.params?.hoaId) return String(req.params.hoaId);
  return null;
}

async function enforceHoaTrialAccess(req, res, next) {
  try {
    if (isAllowlisted(req)) return next();
    if (!req.userId) return next();
    if (!isHOABoardMemberRole(req.user?.role)) return next();

    const hoaId = await resolveHoaId(req);
    if (!hoaId) return next();

    const hoa = await HOA.findOne({ _id: hoaId, isDeleted: { $ne: true } })
      .select('trialStartAt trialEndAt trialStatus subscriptionStatus')
      .lean();
    if (!hoa) return next();

    const status = getHoaSubscriptionStatus(hoa);
    if (status.accessAllowed) return next();

    return responseHelper.error(res, status.message || EXPIRED_MESSAGE, 403, {
      code: 'HOA_TRIAL_EXPIRED',
      trialStatus: status.trialStatus,
      subscriptionStatus: status.subscriptionStatus,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  enforceHoaTrialAccess,
  isAllowlisted,
  EXPIRED_MESSAGE,
};
