/**
 * ------------------------------------------------------------------
 * File: portalInvitation.controller.js
 * Module: Src Shared Modules Auth Controllers
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * auth.routes
 * ------------------------------------------------------------------
 */

const portalInvitationService = require('../services/portalInvitation.service');
const { ValidationError } = require('../../../../common/exceptions');
const { buildLoginMetaFromRequest } = require('../helpers/loginMeta.helper');

const validatePortalInvite = async (req, res, next) => {
  try {
    const { userId, token } = req.query || {};
    const data = await portalInvitationService.validateInvite({ userId, token });
    res.json({
      message: 'Invitation validated',
      statuscode: 200,
      data,
    });
  } catch (err) {
    const status = err.status || 400;
    if (status === 404) return next(err);
    return next(new ValidationError(err.message || 'Invalid invitation'));
  }
};

const completePortalInvite = async (req, res, next) => {
  try {
    const { userId, token, newPassword, confirmPassword } = req.body || {};
    const loginMeta = await buildLoginMetaFromRequest(req);
    const result = await portalInvitationService.completeInvite({
      userId,
      token,
      newPassword,
      confirmPassword,
      loginMeta,
    });
    res.json({
      message: result.message || 'Password set successfully',
      statuscode: 200,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: result.user,
        acknowledgeUrl: result.acknowledgeUrl || null,
      },
    });
  } catch (err) {
    const status = err.status || 400;
    if (status === 404) return next(err);
    if (err.message && err.message.includes('encrypted')) {
      return next(new ValidationError(err.message));
    }
    return next(new ValidationError(err.message || 'Could not complete invitation'));
  }
};

module.exports = {
  validatePortalInvite,
  completePortalInvite,
};
