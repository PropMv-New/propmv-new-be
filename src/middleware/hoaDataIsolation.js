/**
 * ------------------------------------------------------------------
 * File: hoaDataIsolation.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaDataIsolation.
 *
 * Used By:
 * hoaPropertyScope, maintenanceEmailHelper, unitCreditExpenseNoticeEmailHelper, contacts.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const User = require('../shared/modules/users/models/user.model');
const HOAMembership = require('../portals/hoa-board/modules/hoa/model/hoaMembership.model');
const { isHOABoardMemberRole } = require('../common/helpers/hoaBoardRole');
const { isHOAOwnerRole } = require('../common/helpers/hoaOwnerRole');
const { isVendorRole } = require('../common/helpers/hoaVendorRole');
const { resolveUserRoleName } = require('../common/helpers/companyRoleHelper');
const { markPerfStart } = require('../common/helpers/perfTimings');
const { toObjectId } = require('../common/db/mongooseHelpers');
const logger = require('../common/logger');

/**
 * to Id String
 *
 * Performs logic operations for toIdString.
 *
 * @param id - Request/input argument
 * @returns Operations result
 */
function toIdString(id) {
  if (!id) return '';
  return id.toString ? id.toString() : String(id);
}

/**
 * Active user IDs for an HOA (board members who have accepted). Used for shared data access.
 * Short-lived in-process cache (30s TTL) to avoid repeated DB hits on every request.
 *
 * Includes:
 *  - HOAMembership rows with status "active"
 *  - HOA.createdBy (primary board member safety net if membership row is missing)
 */
const _hoaMemberCache = new Map();
const HOA_MEMBER_CACHE_TTL = 30 * 1000; // 30 seconds

async function loadHoaMemberUserIds(hoaId) {
  if (!hoaId) return [];
  const safeHoaId = toObjectId(hoaId);
  if (!safeHoaId) return [];

  const cacheKey = String(hoaId);
  const cached = _hoaMemberCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HOA_MEMBER_CACHE_TTL) {
    return cached.ids;
  }

  const rows = await HOAMembership.find({
    hoaId: safeHoaId,
    status: 'active',
    userId: { $ne: null },
  })
    .select('userId')
    .lean();
  const ids = [...new Set(rows.map((r) => toIdString(r.userId)).filter(Boolean))];

  // Ensure the community creator is always included for multi-board delivery.
  try {
    const HOA = require('../portals/hoa-board/modules/hoa/model/hoa.model');
    const hoa = await HOA.findOne({ _id: safeHoaId, isDeleted: { $ne: true } })
      .select('createdBy')
      .lean();
    const createdBy = toIdString(hoa?.createdBy);
    if (createdBy && !ids.includes(createdBy)) {
      ids.push(createdBy);
    }
  } catch (_) {
    /* ignore — membership list alone is still valid */
  }

  _hoaMemberCache.set(cacheKey, { ids, ts: Date.now() });
  return ids;
}

/**
 * request Path For Hoa Access
 *
 * Performs logic operations for requestPathForHoaAccess.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function requestPathForHoaAccess(req) {
  return `${req.baseUrl || ''}${req.path || ''}`;
}

/**
 * POST bodies that are validated with strict Joi schemas (e.g. only { text } or { content }).
 * Injecting createdBy / hoaId / hoaBoardMemberId causes "field is not allowed" validation errors.
 * Those routes use req.userId and req.hoaContext in controllers/services instead.
 */
function shouldSkipInjectingHoaPostAuditFields(fullPath) {
  if (!fullPath) return false;
  const p = fullPath.toLowerCase();
  if (p.includes('/comments')) return true;
  if (p.includes('/send-reminder')) return true;
  if (p.includes('/waive')) return true;
  if (p.includes('/unwaive')) return true;
  if (p.includes('/maintenance') && p.includes('/notes')) return true;
  if (p.includes('/expense') && p.includes('/notes')) return true;
  if (p.includes('/vendor-invoice') && p.includes('/notes')) return true;
  if (p.includes('/deposit-bank-accounts/reassign')) return true;
  // Email & messaging use strict body schemas; HOA scoping lives on req.hoaContext / req.userId
  if (p.includes('/email')) return true;
  if (p.includes('/messaging')) return true;
  return false;
}

/** GET-by-id routes that must be scoped to the active HOA */
function shouldVerifyHoaGetById(req) {
  if (req.method !== 'GET' || !req.params?.id) return false;
  const p = requestPathForHoaAccess(req).toLowerCase();
  return (
    p.includes('/property')
    || p.includes('/properties')
    || p.includes('/unit')
    || p.includes('/owner')
    || p.includes('/tenant')
    || p.includes('/payees/')
    || (p.includes('/expense') && !p.includes('/payees/'))
    || p.includes('/invoice')
    || p.includes('/income')
    || p.includes('/maintenance')
    || p.includes('/document')
  );
}

/**
 * HOA Data Isolation Middleware
 *
 * Board members in the same HOA share access to HOA-scoped records (properties, owners, invoices, etc.).
 * Rows may be keyed by hoaId and/or by landlord_id / createdBy / hoaBoardMemberId of any active member.
 *
 * HOA membership role (admin vs member) does not restrict operational APIs here: any active board member may
 * create/update the same resources. Admin-only actions stay in hoa.service (e.g. invite, revoke member).
 */
async function unlockExpiredAccount(user) {
  if (!user?.lockAccount || !user.lockUntil || user.lockUntil > new Date()) {
    return user;
  }

  const safeUserId = toObjectId(user._id);
  if (!safeUserId) return user;
  await User.updateOne(
    { _id: safeUserId },
    { $set: { lockAccount: false, lockUntil: null, failedLoginAttempts: 0 } }
  );

  return {
    ...user,
    lockAccount: false,
    lockUntil: null,
    failedLoginAttempts: 0,
  };
}

const hoaDataIsolation = async (req, res, next) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    let activeHoaId = req.headers['x-hoa-id'] || null;
    if (activeHoaId) {
      activeHoaId = String(activeHoaId).trim();
    }

    const HOA_USER_SELECT =
      'companyId companyRoleId lockAccount lockUntil failedLoginAttempts isDeleted email hoaInfo propertyIds associatedHoaIds associatedLandlordIds';
    const cachedAuthUser =
      req.authUser && String(req.authUser._id) === String(userId) ? req.authUser : null;

    const membershipQuery = activeHoaId
      ? HOAMembership.findOne({ hoaId: activeHoaId, userId, status: 'active' }).lean()
      : HOAMembership.findOne({ userId, status: 'active' }).sort({ createdAt: 1 }).lean();

    const [loadedUser, membershipResult] = await Promise.all([
      cachedAuthUser
        ? Promise.resolve(cachedAuthUser)
        : User.findById(userId).select(HOA_USER_SELECT).lean(),
      membershipQuery,
    ]);

    let membership = membershipResult;
    const user = loadedUser;

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const userAfterLock = await unlockExpiredAccount(user);
    req.authUser = userAfterLock;

    if (userAfterLock.isDeleted) {
      return res.status(403).json({ message: 'User account has been deleted' });
    }

    if (userAfterLock.lockAccount && userAfterLock.lockUntil && userAfterLock.lockUntil > new Date()) {
      return res.status(423).json({
        message: 'Account is temporarily locked due to multiple failed login attempts',
        lockUntil: userAfterLock.lockUntil,
        unlockTime: 'Account will be automatically unlocked after lock expiration',
      });
    }

    const userRole =
      req.userRoleName ||
      (await resolveUserRoleName(userAfterLock, { company: req.authCompany || undefined }));

    // HOA owners get a lightweight hoaContext for messaging/email contact scoping.
    // They do not share board-member write injection / shared operational filters.
    if (isHOAOwnerRole(userRole) && !isHOABoardMemberRole(userRole)) {
      let scopedHoaId = null;
      if (activeHoaId) {
        if (!(await ownerBelongsToHoa(userAfterLock, activeHoaId))) {
          return res.status(403).json({ message: 'You do not have access to the requested HOA' });
        }
        scopedHoaId = toIdString(activeHoaId);
      } else {
        scopedHoaId = await resolveHoaIdForOwner(userAfterLock, null);
      }

      if (!scopedHoaId) {
        return next();
      }

      const Property = require('../portals/hoa-board/modules/property/model/property.model');
      const [hoaProperties, hoaMemberUserIds] = await Promise.all([
        Property.find({
          hoaId: scopedHoaId,
          isDeleted: { $ne: true },
        })
          .select('_id')
          .lean(),
        loadHoaMemberUserIds(scopedHoaId),
      ]);

      req.hoaContext = {
        userId: toIdString(userId),
        hoaId: scopedHoaId,
        hoaMemberUserIds,
        propertyIds: hoaProperties.map((p) => p._id),
        ownerPropertyIds: Array.isArray(userAfterLock.propertyIds)
          ? userAfterLock.propertyIds.filter(Boolean)
          : [],
        isHOABoardMember: false,
        isHOAOwner: true,
        role: 'hoa_owner',
      };
      return next();
    }

    // Vendors are standalone entities optionally associated with HOAs (associatedHoaIds).
    // They are NOT HOA members - never require hoaInfo, never 403 solely for missing HOA.
    if (isVendorRole(userRole) && !isHOABoardMemberRole(userRole)) {
      const associatedIds = collectVendorAssociatedHoaIds(userAfterLock);

      let scopedHoaId = null;
      if (activeHoaId) {
        const active = toIdString(activeHoaId);
        if (associatedIds.includes(active)) {
          scopedHoaId = active;
        }
        // Stale / unrelated activeHoaId (e.g. leftover localStorage) - ignore, do not 403
      } else if (associatedIds.length === 1) {
        scopedHoaId = associatedIds[0];
      }

      if (!scopedHoaId) {
        req.hoaContext = {
          userId: toIdString(userId),
          hoaId: null,
          hoaMemberUserIds: [],
          propertyIds: [],
          isHOABoardMember: false,
          isVendor: true,
          role: 'vendor',
          associatedHoaIds: associatedIds,
        };
        return next();
      }

      const Property = require('../portals/hoa-board/modules/property/model/property.model');
      const [hoaProperties, hoaMemberUserIds] = await Promise.all([
        Property.find({
          hoaId: scopedHoaId,
          isDeleted: { $ne: true },
        })
          .select('_id')
          .lean(),
        loadHoaMemberUserIds(scopedHoaId),
      ]);

      req.hoaContext = {
        userId: toIdString(userId),
        hoaId: scopedHoaId,
        hoaMemberUserIds,
        propertyIds: hoaProperties.map((p) => p._id),
        isHOABoardMember: false,
        isVendor: true,
        role: 'vendor',
        associatedHoaIds: associatedIds,
      };
      return next();
    }

    if (!isHOABoardMemberRole(userRole)) {
      return next();
    }

    if (!membership) {
      try {
        const { ensurePrimaryHOAFromUserProfile } = require('../portals/hoa-board/modules/hoa/service/hoa.service');
        await ensurePrimaryHOAFromUserProfile(userId);
        membership = activeHoaId
          ? await HOAMembership.findOne({ hoaId: activeHoaId, userId, status: 'active' }).lean()
          : await HOAMembership.findOne({ userId, status: 'active' }).sort({ createdAt: 1 }).lean();
      } catch (provisionError) {
        logger.error('Failed to provision HOA from user profile', { error: provisionError.message });
      }
    }

    if (activeHoaId) {
      if (!membership) {
        return res.status(403).json({ message: 'You are not a member of the requested HOA' });
      }
    } else {
      activeHoaId = membership ? String(membership.hoaId) : null;
    }

    if (!activeHoaId) {
      return res.status(403).json({
        message:
          'No active HOA membership. If you were removed from an HOA, you no longer have access to its data.',
      });
    }

    const endHoaScope = markPerfStart(req, 'hoaScope');
    const hoaMemberUserIds = await loadHoaMemberUserIds(activeHoaId);
    const hoaPropMatch = buildHoaBoardPropertyMatch({
      userId: toIdString(userId),
      hoaId: activeHoaId,
      hoaMemberUserIds,
      isHOABoardMember: true,
    });
    const Property = require('../portals/hoa-board/modules/property/model/property.model');
    // Cache property IDs per HOA for 30s to avoid repeated full-collection scans on every request
    const propCacheKey = `props_${activeHoaId}`;
    let hoaPropertyIds;
    const propCached = _hoaMemberCache.get(propCacheKey);
    if (propCached && Date.now() - propCached.ts < HOA_MEMBER_CACHE_TTL) {
      hoaPropertyIds = propCached.ids;
    } else {
      const hoaProperties = hoaPropMatch
        ? await Property.find(hoaPropMatch).select('_id').lean()
        : [];
      hoaPropertyIds = hoaProperties.map((p) => p._id);
      _hoaMemberCache.set(propCacheKey, { ids: hoaPropertyIds, ts: Date.now() });
    }

    req.hoaContext = {
      userId: toIdString(userId),
      hoaId: activeHoaId,
      hoaMemberUserIds,
      propertyIds: hoaPropertyIds,
      isHOABoardMember: true,
      role: 'hoa_board_member',
    };
    endHoaScope();

    const pathForVerify = requestPathForHoaAccess(req);

    // Do not inject per-user query params (createdBy / hoaBoardMemberId) - services use req.hoaContext instead.

    if (req.method === 'GET' && req.params.id && shouldVerifyHoaGetById(req)) {
      const canAccess = await verifyHOAResourceAccess(userId, req.params.id, pathForVerify, req.hoaContext);
      if (!canAccess) {
        return res.status(403).json({
          message: 'Access denied. You can only view records in your HOA.',
        });
      }
    }

    if (req.method === 'POST' && !shouldSkipInjectingHoaPostAuditFields(pathForVerify)) {
      req.body = req.body || {};
      req.body.createdBy = userId;
      if (activeHoaId) req.body.hoaId = activeHoaId;
      req.body.hoaBoardMemberId = userId;

      if (pathForVerify.includes('/property') || pathForVerify.includes('/properties')) {
        req.body.landlord_id = userId;
      }
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const resourceId = req.params.id || req.query.propertyId || req.query.id;
      if (resourceId) {
        const canAccess = await verifyHOAResourceAccess(userId, resourceId, pathForVerify, req.hoaContext);
        if (!canAccess) {
          return res.status(403).json({
            message: 'Access denied. You can only modify records in your HOA.',
          });
        }
      }
    }

    if (req.method === 'DELETE') {
      const resourceId = req.params.id || req.query.propertyId || req.query.id;
      if (resourceId) {
        const canAccess = await verifyHOAResourceAccess(userId, resourceId, pathForVerify, req.hoaContext);
        if (!canAccess) {
          return res.status(403).json({
            message: 'Access denied. You can only delete records in your HOA.',
          });
        }
      }
    }

    next();
  } catch (error) {
    logger.error('HOA data isolation error', { error: error.message });
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * member Set From Context
 *
 * Performs logic operations for memberSetFromContext.
 *
 * @param hoaContext - Request/input argument
 * @param userId - Request/input argument
 * @returns Operations result
 */
function memberSetFromContext(hoaContext, userId) {
  if (hoaContext?.hoaMemberUserIds?.length) {
    return new Set(hoaContext.hoaMemberUserIds.map((id) => toIdString(id)));
  }
  return new Set([toIdString(userId)]);
}

/**
 * Mongo filter fragment for properties visible to HOA board members in the active HOA.
 * @param {Object} userContext - req.hoaContext
 * @returns {Object|null} e.g. { $or: [{ hoaId }, { landlord_id: { $in: [...] } }] } or null if not applicable
 */
function buildActiveHoaIdMatch(userContext) {
  if (!userContext?.hoaId) return null;
  const idStr = toIdString(userContext.hoaId);
  if (!idStr) return null;
  if (mongoose.Types.ObjectId.isValid(idStr)) {
    return { hoaId: new mongoose.Types.ObjectId(idStr) };
  }
  return { hoaId: idStr };
}

/**
 * build Hoa Board Property Match
 *
 * Performs logic operations for buildHoaBoardPropertyMatch.
 *
 * @param userContext - Request/input argument
 * @returns Operations result
 */
function buildHoaBoardPropertyMatch(userContext) {
  if (!userContext || !userContext.isHOABoardMember) return null;

  const strictHoaMatch = buildActiveHoaIdMatch(userContext);
  if (strictHoaMatch) return strictHoaMatch;

  let memberIds = Array.isArray(userContext.hoaMemberUserIds)
    ? userContext.hoaMemberUserIds.filter(Boolean).map((id) => toIdString(id))
    : [];
  if (!memberIds.length && userContext.userId) {
    memberIds = [toIdString(userContext.userId)];
  }
  if (!memberIds.length) return null;

  const uid = toIdString(userContext.userId);
  return {
    $or: [
      { createdBy: uid },
      { hoaBoardMemberId: uid },
      { landlord_id: uid },
      { associatedOwnerIds: uid },
    ],
  };
}

async function verifyHOAResourceAccess(userId, resourceId, path, hoaContext = null) {
  try {
    if (!resourceId || !mongoose.Types.ObjectId.isValid(String(resourceId))) return false;

    const members = memberSetFromContext(hoaContext, userId);
    const hoaId = hoaContext?.hoaId ? toIdString(hoaContext.hoaId) : null;

    const propertyAllowed = async (Property, propId) => {
      if (!propId || !mongoose.Types.ObjectId.isValid(String(propId))) return false;
      const property = await Property.findById(propId).lean();
      if (!property) return false;
      if (hoaId) {
        if (property.hoaId) {
          return toIdString(property.hoaId) === hoaId;
        }
        // Legacy property without explicit hoaId: verify via hoaContext.propertyIds
        if (hoaContext?.propertyIds?.length) {
          const allowedIds = new Set(hoaContext.propertyIds.map((id) => toIdString(id)));
          return allowedIds.has(toIdString(property._id));
        }
        return false;
      }
      if (property.landlord_id && members.has(toIdString(property.landlord_id))) return true;
      if (property.createdBy && members.has(toIdString(property.createdBy))) return true;
      if (property.hoaBoardMemberId && members.has(toIdString(property.hoaBoardMemberId))) return true;
      return false;
    };

    // Units must be checked BEFORE /owner check, because unit routes live under /api/v1/owners/units/:id
    if (path.includes('/units') || path.includes('/unit')) {
      const Property = require('../portals/hoa-board/modules/property/model/property.model');
      return propertyAllowed(Property, resourceId);
    }

    if (path.includes('/property') || path.includes('/properties')) {
      const Property = require('../portals/hoa-board/modules/property/model/property.model');
      return propertyAllowed(Property, resourceId);
    }

    if (path.includes('/owner') || path.includes('/tenant')) {
      const OwnerUser = require('../shared/modules/users/models/user.model');
      const row = await OwnerUser.findById(resourceId).lean();
      if (!row) return false;
      if (hoaId && row.hoaInfo?.hoaId) {
        const ownerHoaId = toIdString(row.hoaInfo.hoaId);
        if (ownerHoaId === toIdString(hoaId)) return true;
      }
      if (hoaId && Array.isArray(row.propertyIds) && row.propertyIds.length && hoaContext?.propertyIds?.length) {
        const allowedPropertyIds = new Set(hoaContext.propertyIds.map((id) => toIdString(id)));
        if (row.propertyIds.some((pid) => allowedPropertyIds.has(toIdString(pid)))) return true;
      }
      return false;
    }

    if (path.includes('/payees')) {
      const Payee = require('../portals/hoa-board/modules/expense/model/payee.model');
      const row = await Payee.findById(resourceId).lean();
      if (!row) return false;
      if (hoaId) {
        return Boolean(row.hoaId && toIdString(row.hoaId) === hoaId);
      }
      if (row.createdBy && members.has(toIdString(row.createdBy))) return true;
      if (row.hoaBoardMemberId && members.has(toIdString(row.hoaBoardMemberId))) return true;
      return false;
    }

    if (path.includes('/expense')) {
      const checkExpense = async (Expense) => {
        const expense = await Expense.findById(resourceId).lean();
        if (!expense) return false;
        if (hoaId) {
          if (expense.hoaId) return toIdString(expense.hoaId) === hoaId;
          if (expense.property) {
            const Property = require('../portals/hoa-board/modules/property/model/property.model');
            return propertyAllowed(Property, expense.property);
          }
          return false;
        }
        if (expense.createdBy && members.has(toIdString(expense.createdBy))) return true;
        if (expense.hoaBoardMemberId && members.has(toIdString(expense.hoaBoardMemberId))) return true;
        return false;
      };

      try {
        const Expense = require('../portals/landlord/modules/expense/model/expense.model');
        return await checkExpense(Expense);
      } catch (err) {
        const Expense = require('../portals/hoa-board/modules/expense/model/expense.model');
        return await checkExpense(Expense);
      }
    }

    if (path.includes('/vendor-invoice')) {
      const VendorInvoice = require('../portals/hoa-board/modules/vendor-invoice/model/vendorInvoice.model');
      const vi = await VendorInvoice.findById(resourceId).lean();
      if (!vi) return false;
      if (hoaId && vi.hoaId) {
        return toIdString(vi.hoaId) === hoaId;
      }
      return true;
    }

    if (path.includes('/invoice') || path.includes('/income')) {
      const checkInvoice = async (Invoice) => {
        const invoice = await Invoice.findById(resourceId).lean();
        if (!invoice) return false;
        if (hoaId) {
          if (invoice.hoaId) return toIdString(invoice.hoaId) === hoaId;
          if (invoice.propertyId) {
            const Property = require('../portals/hoa-board/modules/property/model/property.model');
            return propertyAllowed(Property, invoice.propertyId);
          }
          return false;
        }
        if (invoice.createdBy && members.has(toIdString(invoice.createdBy))) return true;
        if (invoice.propertyId) {
          const Property = require('../portals/hoa-board/modules/property/model/property.model');
          return propertyAllowed(Property, invoice.propertyId);
        }
        return false;
      };

      try {
        const Invoice = require('../portals/landlord/modules/invoice/model/invoice.model');
        return await checkInvoice(Invoice);
      } catch (err) {
        const Invoice = require('../portals/hoa-board/modules/invoice/model/invoice.model');
        return await checkInvoice(Invoice);
      }
    }

    if (path.includes('/maintenance')) {
      const MaintenanceRequest = require('../shared/modules/maintenance/model/maintenanceRequest.model');
      const maintenance = await MaintenanceRequest.findById(resourceId).lean();
      if (!maintenance) return false;
      if (hoaId) {
        if (maintenance.hoaId) return toIdString(maintenance.hoaId) === hoaId;
        if (maintenance.property_id) {
          const Property = require('../portals/hoa-board/modules/property/model/property.model');
          return propertyAllowed(Property, maintenance.property_id);
        }
        return false;
      }
      if (maintenance.property_id) {
        const Property = require('../portals/hoa-board/modules/property/model/property.model');
        return propertyAllowed(Property, maintenance.property_id);
      }
      return false;
    }

    if (path.includes('/document')) {
      const HOADocument = require('../shared/modules/documents/model/hoaDocument.model');
      const doc = await HOADocument.findById(resourceId).lean();
      if (!doc) return true; // could be regular landlord document metadata
      if (hoaId && doc.hoaId) {
        return toIdString(doc.hoaId) === hoaId;
      }
      return true;
    }

    return true;
  } catch (error) {
    logger.error('Error verifying HOA resource access', { error: error.message });
    return false;
  }
}

const applyHOADataFilter = (query, userContext) => {
  if (!userContext || !userContext.isHOABoardMember) {
    return query;
  }

  const uid = toIdString(userContext.userId);
  const memberIds =
    Array.isArray(userContext.hoaMemberUserIds) && userContext.hoaMemberUserIds.length
      ? userContext.hoaMemberUserIds.map((id) => toIdString(id)).filter(Boolean)
      : [uid];

  let hoaFilter;
  if (userContext.hoaId) {
    hoaFilter = buildActiveHoaIdMatch(userContext);
  } else {
    hoaFilter = {
      $or: [
        { createdBy: uid },
        { hoaBoardMemberId: uid },
        { landlord_id: uid },
        { associatedOwnerIds: uid },
      ],
    };
  }

  if (query.$and) {
    query.$and.push(hoaFilter);
  } else if (Object.keys(query).length > 0) {
    query = { $and: [query, hoaFilter] };
  } else {
    query = hoaFilter;
  }

  return query;
};

const addHOADataIsolationHooks = (schema) => {
  schema.pre(['find', 'findOne', 'findOneAndUpdate', 'countDocuments'], function () {
    if (this.getOptions().hoaContext && this.getOptions().hoaContext.isHOABoardMember) {
      const ctx = this.getOptions().hoaContext;
      const currentFilter = this.getFilter();
      const uid = toIdString(ctx.userId);
      const memberIds =
        Array.isArray(ctx.hoaMemberUserIds) && ctx.hoaMemberUserIds.length
          ? ctx.hoaMemberUserIds.map((id) => toIdString(id)).filter(Boolean)
          : [uid];
      const hoaFilter = ctx.hoaId
        ? buildActiveHoaIdMatch(ctx)
        : {
          $or: [
            { createdBy: uid },
            { hoaBoardMemberId: uid },
            { landlord_id: uid },
            { associatedOwnerIds: uid },
          ],
        };
      this.setQuery({ $and: [currentFilter, hoaFilter] });
    }
  });

  schema.pre('save', function () {
    if (this.$session && this.$session.hoaContext && this.$session.hoaContext.isHOABoardMember) {
      const uid = this.$session.hoaContext.userId;
      if (this.isNew) {
        this.createdBy = this.createdBy || uid;
        this.hoaBoardMemberId = this.hoaBoardMemberId || uid;
        if (this.constructor.modelName === 'Property' || this.constructor.modelName === 'HOAProperty') {
          this.landlord_id = this.landlord_id || uid;
        }
      }
    }
  });
};

/**
 * build Hoa Id Value Variants
 *
 * Performs logic operations for buildHoaIdValueVariants.
 *
 * @param hoaId - Request/input argument
 * @returns Operations result
 */
function buildHoaIdValueVariants(hoaId) {
  const idStr = toIdString(hoaId);
  if (!idStr) return [];
  const variants = [idStr];
  if (mongoose.Types.ObjectId.isValid(idStr)) {
    variants.push(new mongoose.Types.ObjectId(idStr));
  }
  return variants;
}

/**
 * Vendor association IDs (standalone entity - not HOA membership).
 * Prefers associatedHoaIds; falls back to legacy hoaInfo.hoaId if present.
 */
function collectVendorAssociatedHoaIds(user) {
  const ids = [];
  const seen = new Set();
  const push = (raw) => {
    const id = toIdString(raw);
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  (user?.associatedHoaIds || []).forEach(push);
  if (user?.hoaInfo?.hoaId) push(user.hoaInfo.hoaId);
  return ids;
}

/**
 * Mongo filter fragment: vendors associated with a given HOA.
 */
function buildVendorHoaAssociationFilter(hoaId) {
  const variants = buildHoaIdValueVariants(hoaId);
  if (!variants.length) return null;
  return {
    $or: [
      { associatedHoaIds: { $in: variants } },
      { 'hoaInfo.hoaId': { $in: variants } },
    ],
  };
}

/**
 * Resolve the HOA an owner belongs to (header preference already applied by caller).
 */
async function resolveHoaIdForOwner(user, preferredHoaId = null) {
  if (preferredHoaId && (await ownerBelongsToHoa(user, preferredHoaId))) {
    return toIdString(preferredHoaId);
  }
  if (user?.hoaInfo?.hoaId) {
    return toIdString(user.hoaInfo.hoaId);
  }
  const propertyIds = Array.isArray(user?.propertyIds) ? user.propertyIds.filter(Boolean) : [];
  if (!propertyIds.length) return null;
  const Property = require('../portals/hoa-board/modules/property/model/property.model');
  const safePropertyIds = propertyIds.map(toObjectId).filter(Boolean);
  if (!safePropertyIds.length) return null;
  const prop = await Property.findOne({
    _id: { $in: safePropertyIds },
    hoaId: { $ne: null },
    isDeleted: { $ne: true },
  })
    .select('hoaId')
    .lean();
  return prop?.hoaId ? toIdString(prop.hoaId) : null;
}

/**
 * True when the owner is linked to the HOA via hoaInfo, propertyIds, or associatedOwnerIds.
 */
async function ownerBelongsToHoa(user, hoaId) {
  const target = toIdString(hoaId);
  if (!target || !user) return false;
  if (user.hoaInfo?.hoaId && toIdString(user.hoaInfo.hoaId) === target) {
    return true;
  }

  const Property = require('../portals/hoa-board/modules/property/model/property.model');
  const userId = toIdString(user._id || user.id);
  const hoaIdVariants = buildHoaIdValueVariants(hoaId);
  const userIdVariants = buildHoaIdValueVariants(userId);
  const propertyIds = Array.isArray(user.propertyIds) ? user.propertyIds.filter(Boolean) : [];

  if (propertyIds.length) {
    const linked = await Property.exists({
      _id: { $in: propertyIds },
      hoaId: { $in: hoaIdVariants },
      isDeleted: { $ne: true },
    });
    if (linked) return true;
  }

  if (userIdVariants.length) {
    const associated = await Property.exists({
      hoaId: { $in: hoaIdVariants },
      associatedOwnerIds: { $in: userIdVariants },
      isDeleted: { $ne: true },
    });
    if (associated) return true;
  }

  return false;
}

/**
 * True when the user may load notifications for this community.
 * Board members: active HOAMembership.
 * Owners: hoaInfo, propertyIds, or unit associatedOwnerIds (owners have no membership row).
 * Vendors: associatedHoaIds.
 */
async function userCanAccessHoaCommunity(userId, hoaId) {
  if (!userId || !hoaId) return false;
  const safeHoaId = toObjectId(hoaId);
  const safeUserId = toObjectId(userId);
  if (!safeHoaId || !safeUserId) return false;

  const membership = await HOAMembership.findOne({
    hoaId: safeHoaId,
    userId: safeUserId,
    status: 'active',
  }).select('_id').lean();
  if (membership) return true;

  const user = await User.findById(safeUserId)
    .select('_id hoaInfo propertyIds associatedHoaIds')
    .lean();
  if (!user) return false;

  const target = toIdString(hoaId);
  const associatedHoaIds = [
    ...(Array.isArray(user.associatedHoaIds) ? user.associatedHoaIds : []),
  ].map(toIdString);
  if (associatedHoaIds.includes(target)) return true;

  return ownerBelongsToHoa(user, hoaId);
}

/**
 * Scope HOA owner queries to the active HOA only.
 * Do not match on hoaBoardMemberId alone - the same board member can manage multiple communities.
 */
function buildHoaOwnerUserFilter(hoaContext) {
  if (!hoaContext?.hoaId) return null;

  const hoaIdVariants = buildHoaIdValueVariants(hoaContext.hoaId);
  const orConditions = [
    { 'hoaInfo.hoaId': { $in: hoaIdVariants } },
  ];

  if (Array.isArray(hoaContext.propertyIds) && hoaContext.propertyIds.length) {
    const propertyIds = hoaContext.propertyIds
      .map((id) => {
        const idStr = toIdString(id);
        if (!idStr) return null;
        return mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : idStr;
      })
      .filter(Boolean);
    if (propertyIds.length) {
      orConditions.push({ propertyIds: { $in: propertyIds } });
    }
  }

  return { $or: orConditions };
}

module.exports = {
  hoaDataIsolation,
  verifyHOAResourceAccess,
  applyHOADataFilter,
  addHOADataIsolationHooks,
  buildActiveHoaIdMatch,
  buildHoaBoardPropertyMatch,
  buildHoaOwnerUserFilter,
  buildVendorHoaAssociationFilter,
  collectVendorAssociatedHoaIds,
  loadHoaMemberUserIds,
  resolveHoaIdForOwner,
  ownerBelongsToHoa,
  userCanAccessHoaCommunity,
  invalidateHoaCache: (hoaId) => {
    if (!hoaId) return;
    const key = String(hoaId);
    _hoaMemberCache.delete(key);
    _hoaMemberCache.delete(`props_${key}`);
    try {
      const { invalidateContactsCaches } = require('../common/services/contacts.service');
      invalidateContactsCaches(hoaId);
    } catch (_) {
      /* contacts cache is best-effort */
    }
  },
};
