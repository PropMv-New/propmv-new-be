/**
 * ------------------------------------------------------------------
 * File: hoaOwnerPropertyAccess.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaOwnerPropertyAccess.
 *
 * Used By:
 * billingSettings.routes, owner.routes
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { isHOAOwnerRole } = require('../common/helpers/hoaOwnerRole');
const { isHOABoardMemberRole } = require('../common/helpers/hoaBoardRole');

/**
 * Returns true when the user is linked to the property as an HOA owner.
 */
async function ownerHasPropertyAccess(userId, propertyId) {
  if (!userId || !propertyId || !mongoose.Types.ObjectId.isValid(String(propertyId))) {
    return false;
  }

  const User = require('../shared/modules/users/models/user.model');
  const Property = require('../portals/hoa-board/modules/property/model/property.model');

  const userObjectId = new mongoose.Types.ObjectId(String(userId));
  const propertyObjectId = new mongoose.Types.ObjectId(String(propertyId));

  const owner = await User.findById(userObjectId).select('propertyIds').lean();
  const fromProfile = (owner?.propertyIds || []).some((id) => String(id) === String(propertyId));
  if (fromProfile) return true;

  const property = await Property.findOne({
    _id: propertyObjectId,
    isDeleted: { $ne: true },
    associatedOwnerIds: userObjectId,
  })
    .select('_id')
    .lean();

  return Boolean(property);
}

/**
 * Express middleware: HOA owners may only access properties they own.
 * Board members pass through (handled by privilege middleware on the route).
 */
async function requireOwnerPropertyAccess(req, res, next) {
  try {
    if (isHOABoardMemberRole(req.user?.role)) {
      return next();
    }

    if (!isHOAOwnerRole(req.user?.role)) {
      return res.status(403).json({
        message: 'Authorization failed: role not permitted for this resource',
        statuscode: 403,
        data: null,
      });
    }

    const userId = req.userId || req.user?._id || req.user?.id;
    const propertyId =
      req.params.propertyId ||
      req.params.id ||
      req.query.propertyId ||
      req.body?.propertyId;

    if (!propertyId) {
      return res.status(400).json({ message: 'propertyId is required', statuscode: 400, data: null });
    }

    const allowed = await ownerHasPropertyAccess(userId, propertyId);
    if (!allowed) {
      return res.status(403).json({
        message: 'Authorization failed: you do not have access to this property',
        statuscode: 403,
        data: null,
      });
    }

    return next();
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Access check failed', statuscode: 500, data: null });
  }
}

/**
 * Batch variant for POST { unitIds: string[] } - every id must belong to the owner.
 */
async function requireOwnerPropertyBatchAccess(req, res, next) {
  try {
    if (isHOABoardMemberRole(req.user?.role)) {
      return next();
    }

    if (!isHOAOwnerRole(req.user?.role)) {
      return res.status(403).json({
        message: 'Authorization failed: role not permitted for this resource',
        statuscode: 403,
        data: null,
      });
    }

    const userId = req.userId || req.user?._id || req.user?.id;
    const unitIds = Array.isArray(req.body?.unitIds) ? req.body.unitIds : [];

    for (const propertyId of unitIds) {
      const allowed = await ownerHasPropertyAccess(userId, propertyId);
      if (!allowed) {
        return res.status(403).json({
          message: 'Authorization failed: you do not have access to one or more properties',
          statuscode: 403,
          data: null,
        });
      }
    }

    return next();
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Access check failed', statuscode: 500, data: null });
  }
}

module.exports = {
  ownerHasPropertyAccess,
  requireOwnerPropertyAccess,
  requireOwnerPropertyBatchAccess,
};
