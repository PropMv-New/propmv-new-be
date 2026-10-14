/**
 * ------------------------------------------------------------------
 * File: roleBasedDataIsolation.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for roleBasedDataIsolation.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// User model is shared across all portals
const User = require('../shared/modules/users/models/user.model');
const { isHOABoardMemberRole } = require('../common/helpers/hoaBoardRole');
const { resolveUserRoleName } = require('../common/helpers/companyRoleHelper');
const {
  buildApplicationOwnerFilter,
  buildPropertyOwnerFilter,
  resolveCreatedBy,
} = require('../shared/utils/creatorScope.util');
const logger = require('../common/logger');

/**
 * Unified Role-Based Data Isolation Middleware
 * Handles data isolation for both HOA Board Members and Landlords
 */
const roleBasedDataIsolation = async (req, res, next) => {
  try {
    const userId = req.userId || req.user?._id;
    
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const portal = req.baseUrl?.includes('/hoa-board') ? 'hoa-board' : 'landlord';

    const user = await User.findOne({ _id: userId, isDeleted: { $ne: true } })
      .select('role companyId companyRoleId')
      .lean();
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const userRole = await resolveUserRoleName(user);
    const normalizedRole = userRole?.toLowerCase();

    // Set context based on role
    if (isHOABoardMemberRole(userRole)) {
      req.userContext = {
        userId: userId,
        role: 'hoa_board',
        isHOABoardMember: true,
        isLandlord: false
      };
      applyHOAFilters(req);
    } else if (normalizedRole === 'landlord') {
      req.userContext = {
        userId: userId,
        role: 'landlord',
        isLandlord: true,
        isHOABoardMember: false
      };
      applyLandlordFilters(req);
    } else {
      // Other roles - no isolation
      req.userContext = {
        userId: userId,
        role: normalizedRole,
        isLandlord: false,
        isHOABoardMember: false
      };
    }

    // Verify access for modification operations
    if (['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const resourceId = req.params.id;
      if (resourceId && (req.userContext.isHOABoardMember || req.userContext.isLandlord)) {
        const canAccess = await verifyResourceAccess(userId, resourceId, req.path, req.userContext);
        if (!canAccess) {
          return res.status(403).json({ 
            message: 'Access denied. You can only modify your own records.' 
          });
        }
      }
    }

    next();
  } catch (error) {
    logger.error('Role-based data isolation error', { error: error.message });
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * apply H O A Filters
 *
 * Performs logic operations for applyHOAFilters.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function applyHOAFilters(req) {
  const userId = req.userContext.userId;
  const path = req.route?.path || req.path;

  if (req.method === 'GET') {
    req.query = req.query || {};
    
    if (path.includes('/property') || path.includes('/properties')) {
      req.query.hoaBoardMemberId = userId;
    }
    if (path.includes('/owner') || path.includes('/tenant')) {
      req.query.createdBy = userId;
    }
    if (path.includes('/expense') || path.includes('/invoice') || path.includes('/income')) {
      req.query.createdBy = userId;
    }
    if (path.includes('/maintenance')) {
      req.query.hoaBoardMemberId = userId;
    }
  }

  if (req.method === 'POST') {
    req.body = req.body || {};
    req.body.createdBy = userId;
    req.body.hoaBoardMemberId = userId;
    
    if (path.includes('/property') || path.includes('/properties')) {
      req.body.landlord_id = userId;
    }
  }
}

/**
 * apply Landlord Filters
 *
 * Performs logic operations for applyLandlordFilters.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function applyLandlordFilters(req) {
  const userId = req.userContext.userId;
  const path = req.route?.path || req.path;

  if (req.method === 'GET') {
    req.query = req.query || {};
    req.query.createdBy = resolveCreatedBy(req.query, userId) || userId;
    delete req.query.landlordId;
    delete req.query.landlord_id;
    
    if (path.includes('/property') || path.includes('/properties')) {
      req.query.createdBy = userId;
    }
    if (path.includes('/tenant') || path.includes('/lease')) {
      req.query.createdBy = userId;
    }
    if (path.includes('/expense') || path.includes('/invoice') || path.includes('/income')) {
      req.query.createdBy = userId;
    }
    if (path.includes('/maintenance')) {
      req.query.createdBy = userId;
    }
  }

  if (req.method === 'POST') {
    req.body = req.body || {};
    req.body.createdBy = resolveCreatedBy(req.body, userId) || userId;
    delete req.body.landlordId;
    delete req.body.landlord_id;
  }
}

async function verifyResourceAccess(userId, resourceId, path, userContext) {
  try {
    if (path.includes('/property') || path.includes('/properties')) {
      const Property = require('../portals/landlord/modules/property/model/property.model');
      const filter = userContext.isHOABoardMember 
        ? { _id: resourceId, hoaBoardMemberId: userId, isDeleted: { $ne: true } }
        : { _id: resourceId, ...buildPropertyOwnerFilter(userId), isDeleted: { $ne: true } };
      const property = await Property.findOne(filter).lean();
      return !!property;
    }
    
    if (path.includes('/expense')) {
      const Expense = require('../shared/modules/expense/model/expense.model');
      const filter = userContext.isHOABoardMember
        ? { _id: resourceId, createdBy: userId, isDeleted: { $ne: true } }
        : { _id: resourceId, ...buildApplicationOwnerFilter(userId), isDeleted: { $ne: true } };
      const expense = await Expense.findOne(filter).lean();
      return !!expense;
    }
    
    if (path.includes('/invoice') || path.includes('/income')) {
      const Invoice = require('../portals/landlord/modules/invoice/model/invoice.model');
      const filter = userContext.isHOABoardMember
        ? { _id: resourceId, createdBy: userId, isDeleted: { $ne: true } }
        : { _id: resourceId, ...buildApplicationOwnerFilter(userId), isDeleted: { $ne: true } };
      const invoice = await Invoice.findOne(filter).lean();
      return !!invoice;
    }
    
    if (path.includes('/maintenance')) {
      const MaintenanceRequest = require('../shared/modules/maintenance/model/maintenanceRequest.model');
      const Property = require('../portals/landlord/modules/property/model/property.model');
      const maintenance = await MaintenanceRequest.findOne({ _id: resourceId, isDeleted: { $ne: true } }).lean();
      if (maintenance && maintenance.property_id) {
        const filter = userContext.isHOABoardMember
          ? { _id: maintenance.property_id, hoaBoardMemberId: userId, isDeleted: { $ne: true } }
          : { _id: maintenance.property_id, ...buildPropertyOwnerFilter(userId), isDeleted: { $ne: true } };
        const property = await Property.findOne(filter).lean();
        return !!property;
      }
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error('Error verifying resource access', { error: error.message });
    return false;
  }
}

const applyRoleBasedDataFilter = (query, userContext) => {
  if (!userContext || (!userContext.isHOABoardMember && !userContext.isLandlord)) {
    return query;
  }

  let roleFilter;
  if (userContext.isHOABoardMember) {
    roleFilter = {
      $or: [
        { createdBy: userContext.userId },
        { hoaBoardMemberId: userContext.userId },
        { landlord_id: userContext.userId },
        { associatedOwnerIds: userContext.userId }
      ]
    };
  } else if (userContext.isLandlord) {
    roleFilter = buildApplicationOwnerFilter(userContext.userId);
  }

  if (query.$and) {
    query.$and.push(roleFilter);
  } else if (Object.keys(query).length > 0) {
    query = { $and: [query, roleFilter] };
  } else {
    query = roleFilter;
  }

  return query;
};

module.exports = {
  roleBasedDataIsolation,
  applyRoleBasedDataFilter,
  verifyResourceAccess
};
