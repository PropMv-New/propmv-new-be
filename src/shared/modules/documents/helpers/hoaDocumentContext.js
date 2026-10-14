/**
 * ------------------------------------------------------------------
 * File: hoaDocumentContext.js
 * Module: Documents Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaDocumentContext.
 *
 * Used By:
 * documents.controller, hoa.controller
 * ------------------------------------------------------------------
 */

const User = require('../../users/models/user.model');
const { isHOAOwnerRole } = require('./hoaDocumentAccess');
const { resolveUserRoleName } = require('../../../../common/helpers/companyRoleHelper');

async function getRequestRole(req) {
  const tokenRole = req.user?.role;
  if (tokenRole) return tokenRole;

  const userId = req.user?.id || req.user?._id || req.userId;
  if (!userId) return '';

  try {
    const user = await User.findById(userId).select('role companyId companyRoleId').lean();
    return (await resolveUserRoleName(user)) || '';
  } catch (_err) {
    return '';
  }
}

/** Resolve active HOA scope from middleware or owner profile. */
async function resolveDocumentHoaContext(req) {
  if (req.hoaContext?.hoaId) {
    return req.hoaContext;
  }

  const role = await getRequestRole(req);
  if (!isHOAOwnerRole(role)) return null;

  const userId = req.user?.id || req.user?._id || req.userId;
  if (!userId) return null;

  try {
    const user = await User.findById(userId).select('hoaInfo').lean();
    if (user?.hoaInfo?.hoaId) {
      return { hoaId: String(user.hoaInfo.hoaId), isHOABoardMember: false };
    }
  } catch (_err) {
    return null;
  }
  return null;
}

module.exports = {
  getRequestRole,
  resolveDocumentHoaContext,
};
