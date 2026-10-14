/**
 * ------------------------------------------------------------------
 * File: landlordDataIsolation.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for landlordDataIsolation.
 *
 * Used By:
 * landlordRouteConfig
 * ------------------------------------------------------------------
 */

const User = require('../shared/modules/users/models/user.model');
const { resolveUserRoleName } = require('../common/helpers/companyRoleHelper');
const {
  buildApplicationOwnerFilter,
  buildPropertyOwnerFilter,
  resolveCreatedBy,
} = require('../shared/utils/creatorScope.util');
const logger = require('../common/logger');

/**
 * Landlord Data Isolation Middleware
 * Enforces strict data isolation for Landlords by filtering data based on ownership
 */
const landlordDataIsolation = async (req, res, next) => {
  try {
    const userId = req.userId || req.user?._id;
    
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const user = await User.findOne({ _id: userId, isDeleted: { $ne: true } })
      .select('companyId companyRoleId')
      .lean();
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const userRole = await resolveUserRoleName(user);
    
    if (userRole && userRole.toLowerCase() === 'landlord') {
      req.landlordContext = {
        userId: userId,
        role: 'landlord',
        isLandlord: true
      };

      if (req.method === 'GET') {
        req.query = req.query || {};
        const path = req.route?.path || req.path;
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

      if (req.method === 'PUT' || req.method === 'PATCH') {
        const resourceId = req.params.id;
        if (resourceId) {
          const canAccess = await verifyLandlordResourceAccess(userId, resourceId, req.path);
          if (!canAccess) {
            return res.status(403).json({ 
              message: 'Access denied. You can only modify your own records.' 
            });
          }
        }
      }

      if (req.method === 'DELETE') {
        const resourceId = req.params.id;
        if (resourceId) {
          const canAccess = await verifyLandlordResourceAccess(userId, resourceId, req.path);
          if (!canAccess) {
            return res.status(403).json({ 
              message: 'Access denied. You can only delete your own records.' 
            });
          }
        }
      }
    }

    next();
  } catch (error) {
    logger.error('Landlord data isolation error', { error: error.message });
    return res.status(500).json({ message: 'Internal server error' });
  }
};

async function verifyLandlordResourceAccess(userId, resourceId, path) {
  try {
    if (path.includes('/property') || path.includes('/properties')) {
      const Property = require('../portals/landlord/modules/property/model/property.model');
      const property = await Property.findOne({ 
        _id: resourceId, 
        ...buildPropertyOwnerFilter(userId),
        isDeleted: { $ne: true }
      }).lean();
      return !!property;
    }
    
    if (path.includes('/tenant') || path.includes('/lease')) {
      const Lease = require('../portals/landlord/modules/leasing/model/lease.model');
      const lease = await Lease.findOne({ 
        _id: resourceId, 
        ...buildApplicationOwnerFilter(userId),
        isDeleted: { $ne: true }
      }).lean();
      return !!lease;
    }
    
    if (path.includes('/expense')) {
      const Expense = require('../shared/modules/expense/model/expense.model');
      const expense = await Expense.findOne({ 
        _id: resourceId, 
        ...buildApplicationOwnerFilter(userId),
        isDeleted: { $ne: true }
      }).lean();
      return !!expense;
    }
    
    if (path.includes('/invoice') || path.includes('/income')) {
      const Invoice = require('../portals/landlord/modules/invoice/model/invoice.model');
      const invoice = await Invoice.findOne({ 
        _id: resourceId, 
        ...buildApplicationOwnerFilter(userId),
        isDeleted: { $ne: true }
      }).lean();
      return !!invoice;
    }
    
    if (path.includes('/maintenance')) {
      const MaintenanceRequest = require('../shared/modules/maintenance/model/maintenanceRequest.model');
      const Property = require('../portals/landlord/modules/property/model/property.model');
      const maintenance = await MaintenanceRequest.findOne({ _id: resourceId, isDeleted: { $ne: true } }).lean();
      if (maintenance && maintenance.property_id) {
        const property = await Property.findOne({ 
          _id: maintenance.property_id, 
          ...buildPropertyOwnerFilter(userId),
          isDeleted: { $ne: true }
        }).lean();
        return !!property;
      }
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error('Error verifying landlord resource access', { error: error.message });
    return false;
  }
}

const applyLandlordDataFilter = (query, userContext) => {
  if (!userContext || !userContext.isLandlord) {
    return query;
  }

  const landlordFilter = buildApplicationOwnerFilter(userContext.userId);

  if (query.$and) {
    query.$and.push(landlordFilter);
  } else if (Object.keys(query).length > 0) {
    query = { $and: [query, landlordFilter] };
  } else {
    query = landlordFilter;
  }

  return query;
};

module.exports = {
  landlordDataIsolation,
  verifyLandlordResourceAccess,
  applyLandlordDataFilter
};
