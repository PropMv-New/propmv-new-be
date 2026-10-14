/**
 * ------------------------------------------------------------------
 * File: activity.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * entityNoteActivity.service, activity.controller, dashboard.service, expense.service
 * ------------------------------------------------------------------
 */

const Activity = require('../model/activity.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { applyHOADataFilter } = require('../../../../../middleware/hoaDataIsolation');
const mongoose = require('mongoose');
const logger = require('../../../../../common/logger');
const { ClockService, DateUtil } = require('../../../../../common/date');

function toObjectId(value) {
  const str = String(
    value && typeof value === 'object' && value._id ? value._id : value ?? ''
  ).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

async function logActivity({
  userId,
  action,
  module,
  entityType,
  entityId,
  entityName,
  description,
  metadata = {},
  meta = {},
  role,
  hoaId,
}) {
  try {
    const safeEntityId = toObjectId(entityId) || entityId;
    let effectiveHoaId = toObjectId(hoaId) || toObjectId(meta.hoaId) || toObjectId(metadata.hoaId);

    // If hoaId is not explicitly provided, infer it through existing data relationships
    if (!effectiveHoaId && safeEntityId) {
      const resolvedModule = module || entityType;
      try {
        if (resolvedModule === 'Property' || resolvedModule === 'Unit' || resolvedModule === 'HOA Unit Ownership' || resolvedModule === 'HOA Unit Balance') {
          const Property = require('../../property/model/property.model');
          const p = await Property.findById(safeEntityId).select('hoaId').lean();
          if (p?.hoaId) effectiveHoaId = toObjectId(p.hoaId);
        } else if (resolvedModule === 'Invoice' || resolvedModule === 'Income') {
          const Invoice = require('../../invoice/model/invoice.model');
          const inv = await Invoice.findById(safeEntityId).select('hoaId propertyId').lean();
          if (inv?.hoaId) {
            effectiveHoaId = toObjectId(inv.hoaId);
          } else if (inv?.propertyId) {
            const Property = require('../../property/model/property.model');
            const p = await Property.findById(inv.propertyId).select('hoaId').lean();
            if (p?.hoaId) effectiveHoaId = toObjectId(p.hoaId);
          }
        } else if (resolvedModule === 'Expense') {
          const Expense = require('../../expense/model/expense.model');
          const exp = await Expense.findById(safeEntityId).select('hoaId property').lean();
          if (exp?.hoaId) {
            effectiveHoaId = toObjectId(exp.hoaId);
          } else if (exp?.property) {
            const Property = require('../../property/model/property.model');
            const p = await Property.findById(exp.property).select('hoaId').lean();
            if (p?.hoaId) effectiveHoaId = toObjectId(p.hoaId);
          }
        } else if (resolvedModule === 'Maintenance') {
          const MaintenanceRequest = require('../../../../../shared/modules/maintenance/model/maintenanceRequest.model');
          const m = await MaintenanceRequest.findById(safeEntityId).select('hoaId property_id').lean();
          if (m?.hoaId) {
            effectiveHoaId = toObjectId(m.hoaId);
          } else if (m?.property_id) {
            const Property = require('../../property/model/property.model');
            const p = await Property.findById(m.property_id).select('hoaId').lean();
            if (p?.hoaId) effectiveHoaId = toObjectId(p.hoaId);
          }
        } else if (resolvedModule === 'Owner' || resolvedModule === 'User') {
          const u = await User.findById(safeEntityId).select('hoaInfo propertyIds').lean();
          if (u?.hoaInfo?.hoaId) {
            effectiveHoaId = toObjectId(u.hoaInfo.hoaId);
          } else if (Array.isArray(u?.propertyIds) && u.propertyIds.length) {
            const Property = require('../../property/model/property.model');
            const p = await Property.findOne({ _id: { $in: u.propertyIds }, hoaId: { $ne: null } }).select('hoaId').lean();
            if (p?.hoaId) effectiveHoaId = toObjectId(p.hoaId);
          }
        } else if (resolvedModule === 'Settings') {
          const HOA = require('../../hoa/model/hoa.model');
          const isHoa = await HOA.exists({ _id: safeEntityId });
          if (isHoa) {
            effectiveHoaId = safeEntityId;
          } else {
            const Payee = require('../../expense/model/payee.model');
            const payee = await Payee.findById(safeEntityId).select('hoaId').lean();
            if (payee?.hoaId) effectiveHoaId = toObjectId(payee.hoaId);
          }
        } else if (resolvedModule === 'Document') {
          try {
            const HoaDocument = require('../../../../../shared/modules/documents/model/hoaDocument.model');
            const doc = await HoaDocument.findById(safeEntityId).select('hoaId').lean();
            if (doc?.hoaId) effectiveHoaId = toObjectId(doc.hoaId);
          } catch (docErr) {
            // Ignore if HoaDocument model not mounted
          }
        }
      } catch (err) {
        logger.warn('Failed to infer hoaId for activity log:', err.message);
      }
    }

    const activityData = {
      performedBy: userId,
      action: action.toUpperCase(),
      module: module || entityType || 'Other',
      entityId,
      entityName,
      description,
      hoaId: effectiveHoaId || undefined,
      meta: { ...metadata, ...meta, ...(effectiveHoaId ? { hoaId: effectiveHoaId } : {}) },
      role,
      // Legacy fields for backward compatibility
      user_id: userId,
      entityType: module || entityType,
      metadata: { ...metadata, ...meta, ...(effectiveHoaId ? { hoaId: effectiveHoaId } : {}) },
    };

    await Activity.create(activityData);
  } catch (error) {
    logger.error('Failed to log activity:', error);
  }
}

async function getRecentActivities({
  userId,
  limit = 50,
  page = 1,
  module,
  performedBy,
  userContext = null,
  communityId = null,
  days = 2,
  startDate,
  endDate,
}) {
  const skip = (page - 1) * limit;

  let filter = {};

  const rangeStart = startDate ? DateUtil.startOfDayEST(startDate) : null;
  const rangeEnd = endDate ? DateUtil.endOfDayEST(endDate) : null;
  let validDays = null;

  if (rangeStart && rangeEnd) {
    filter.createdAt = { $gte: rangeStart, $lte: rangeEnd };
  } else {
    const daysNum = parseInt(days, 10);
    validDays = (daysNum >= 1 && daysNum <= 30) ? daysNum : 2;
    filter.createdAt = { $gte: DateUtil.subtractDays(ClockService.now(), validDays) };
  }
  
  // HOA community scoping
  const activeHoaId = communityId || userContext?.hoaId || null;
  const targetHoaOid = toObjectId(activeHoaId);

  if (userContext?.isHOABoardMember || targetHoaOid) {
    // If userContext is present and specifies a hoaId, and a different community was explicitly queried:
    if (userContext?.hoaId && activeHoaId && String(userContext.hoaId).trim() !== String(activeHoaId).trim()) {
      const err = new Error('You do not have access to the requested HOA community');
      err.status = 403;
      throw err;
    }

    if (!targetHoaOid) {
      return {
        data: [],
        total: 0,
        page,
        limit,
        days: validDays,
      };
    }

    const Property = require('../../property/model/property.model');
    const Invoice = require('../../invoice/model/invoice.model');
    const Expense = require('../../expense/model/expense.model');
    const MaintenanceRequest = require('../../../../../shared/modules/maintenance/model/maintenanceRequest.model');
    const Payee = require('../../expense/model/payee.model');

    // 1. Properties belonging to this community
    let propIds = Array.isArray(userContext?.propertyIds) && userContext.propertyIds.length
      ? userContext.propertyIds.map(toObjectId).filter(Boolean)
      : [];
    if (!propIds.length) {
      propIds = await Property.find({ hoaId: targetHoaOid, isDeleted: { $ne: true } }).distinct('_id');
    }

    // 2. Invoices belonging to this community
    const invoiceFilter = propIds.length
      ? { $or: [{ hoaId: targetHoaOid }, { propertyId: { $in: propIds } }], isDeleted: { $ne: true } }
      : { hoaId: targetHoaOid, isDeleted: { $ne: true } };
    const communityInvoiceIds = await Invoice.distinct('_id', invoiceFilter);

    // 3. Owners belonging to this community
    const ownerConditions = [{ 'hoaInfo.hoaId': targetHoaOid }];
    if (propIds.length) {
      ownerConditions.push({ propertyIds: { $in: propIds } });
    }
    const directOwnerIds = await User.distinct('_id', { $or: ownerConditions });
    const associatedOwnerIds = propIds.length
      ? await Property.distinct('associatedOwnerIds', { _id: { $in: propIds } })
      : [];
    const communityOwnerIds = Array.from(
      new Set([...directOwnerIds.map(String), ...associatedOwnerIds.map(String)])
    ).map(toObjectId).filter(Boolean);

    // 4. Expenses belonging to this community
    const expenseFilter = propIds.length
      ? { $or: [{ hoaId: targetHoaOid }, { property: { $in: propIds } }], isDeleted: { $ne: true } }
      : { hoaId: targetHoaOid, isDeleted: { $ne: true } };
    const communityExpenseIds = await Expense.distinct('_id', expenseFilter);

    // 5. Maintenance requests belonging to this community
    const maintenanceFilter = propIds.length
      ? { $or: [{ hoaId: targetHoaOid }, { property_id: { $in: propIds } }], isDeleted: { $ne: true } }
      : { hoaId: targetHoaOid, isDeleted: { $ne: true } };
    const communityMaintenanceIds = await MaintenanceRequest.distinct('_id', maintenanceFilter);

    // 6. Payees for Settings
    const communityPayeeIds = await Payee.distinct('_id', { hoaId: targetHoaOid, isDeleted: { $ne: true } });

    // Build relational and direct community match clauses
    const communityOrClauses = [
      { hoaId: targetHoaOid },
      { 'meta.hoaId': targetHoaOid },
      { 'metadata.hoaId': targetHoaOid },
      { 'meta.hoaId': String(targetHoaOid) },
      { 'metadata.hoaId': String(targetHoaOid) },
      { module: 'Settings', entityId: { $in: [targetHoaOid, ...communityPayeeIds] } },
    ];

    if (propIds.length) {
      communityOrClauses.push({
        module: { $in: ['Property', 'Unit', 'HOA Unit Ownership', 'HOA Unit Balance'] },
        entityId: { $in: propIds },
      });
    }

    if (communityInvoiceIds.length) {
      communityOrClauses.push({
        module: { $in: ['Invoice', 'Income'] },
        entityId: { $in: communityInvoiceIds },
      });
    }

    if (communityOwnerIds.length) {
      communityOrClauses.push({
        module: { $in: ['Owner', 'User'] },
        entityId: { $in: communityOwnerIds },
      });
    }

    if (communityExpenseIds.length) {
      communityOrClauses.push({
        module: 'Expense',
        entityId: { $in: communityExpenseIds },
      });
    }

    if (communityMaintenanceIds.length) {
      communityOrClauses.push({
        module: 'Maintenance',
        entityId: { $in: communityMaintenanceIds },
      });
    }

    try {
      const HoaDocument = require('../../../../../shared/modules/documents/model/hoaDocument.model');
      const communityDocIds = await HoaDocument.distinct('_id', { hoaId: targetHoaOid, isDeleted: { $ne: true } });
      if (communityDocIds.length) {
        communityOrClauses.push({
          module: 'Document',
          entityId: { $in: communityDocIds },
        });
      }
    } catch (docErr) {
      // Ignore if document model not present
    }

    filter.$or = communityOrClauses;
  } else if (userContext) {
    filter = applyHOADataFilter(filter, userContext);
  }
  
  // Filter by user if provided (for user-specific activity)
  if (userId) {
    filter.performedBy = userId;
  }
  
  // Filter by module if provided (HOA board never surfaces landlord lease/application activity)
  if (module) {
    if (userContext?.isHOABoardMember && module === 'Lease') {
      filter.module = { $in: [] };
    } else {
      filter.module = module;
    }
  } else if (userContext?.isHOABoardMember) {
    filter.module = { $nin: ['Lease'] };
  }
  
  // Filter by performedBy if provided
  if (performedBy) {
    filter.performedBy = performedBy;
  }
  
  const [activities, total] = await Promise.all([
    Activity.find(filter)
      .populate('performedBy', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Activity.countDocuments(filter)
  ]);
  
  // Format activities for frontend
  const formattedActivities = activities.map(activity => {
    const redirectUrl = activity.action !== 'DELETE' ? getRedirectUrl(activity.module, activity.entityId) : null;
    
    return {
      id: activity._id,
      module: activity.module,
      action: activity.action,
      description: activity.description,
      performedBy: activity.performedBy ? 
        `${activity.performedBy.firstName || ''} ${activity.performedBy.lastName || ''}`.trim() || activity.performedBy.email :
        'Unknown',
      performedById: activity.performedBy?._id,
      role: activity.role || activity.performedBy?.role,
      timestamp: activity.createdAt,
      entityId: activity.entityId,
      entityName: activity.entityName,
      meta: activity.meta,
      redirectUrl
    };
  });
  
  return {
    data: formattedActivities,
    total,
    page,
    limit,
    days: validDays,
  };
}

/**
 * get Redirect Url
 *
 * Performs logic operations for getRedirectUrl.
 *
 * @param module - Request/input argument
 * @param entityId - Request/input argument
 * @returns Operations result
 */
function getRedirectUrl(module, entityId) {
  const routes = {
    'Property': `/property/${entityId}`,
    'Unit': `/hoa/units/${entityId}/edit`,
    'Owner': `/property-owners/${entityId}`,
    'Income': `/income/${entityId}`,
    'Invoice': `/income/${entityId}`,
    'Expense': `/expenses/${entityId}`,
    'Maintenance': `/maintenance/${entityId}`,
    'Document': '/documents',
    'Tenant': null,
    'Settings': '/settings/payment',
    'Messaging': '/messaging',
    'User': '/settings/payment',
  };
  return routes[module] || null;
}

const CLIENT_LOG_MODULES = new Set(['Settings']);
const CLIENT_LOG_ACTIONS = new Set(['CREATE', 'UPDATE', 'DELETE']);

async function logClientActivity({
  userId,
  action,
  module,
  entityId,
  entityName,
  description,
  meta = {},
  hoaContext = null,
}) {
  if (!hoaContext?.isHOABoardMember) {
    const err = new Error('Only HOA members can log activity');
    err.status = 403;
    throw err;
  }

  const normalizedAction = String(action || '').toUpperCase();
  if (!CLIENT_LOG_ACTIONS.has(normalizedAction)) {
    const err = new Error('Invalid action');
    err.status = 400;
    throw err;
  }

  if (!CLIENT_LOG_MODULES.has(module)) {
    const err = new Error('Invalid module');
    err.status = 400;
    throw err;
  }

  const trimmedDescription = String(description || '').trim();
  if (!trimmedDescription) {
    const err = new Error('Description is required');
    err.status = 400;
    throw err;
  }

  let resolvedEntityId = entityId;
  if (!resolvedEntityId || !mongoose.Types.ObjectId.isValid(String(resolvedEntityId))) {
    resolvedEntityId = hoaContext.hoaId;
  }
  if (!resolvedEntityId || !mongoose.Types.ObjectId.isValid(String(resolvedEntityId))) {
    const err = new Error('Valid entityId is required');
    err.status = 400;
    throw err;
  }

  await logActivity({
    userId,
    action: normalizedAction,
    module,
    entityId: resolvedEntityId,
    entityName: entityName ? String(entityName).slice(0, 200) : undefined,
    description: trimmedDescription.slice(0, 500),
    meta,
    hoaId: hoaContext?.hoaId,
  });
}

module.exports = {
  logActivity,
  getRecentActivities,
  logClientActivity,
};
