/**
 * ------------------------------------------------------------------
 * File: property.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * property.controller
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const Property = require('../model/property.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { applyHOADataFilter } = require('../../../../../middleware/hoaDataIsolation');
const { MAINTENANCE_STATUS, PROPERTY_STATUS } = require('../../../../../common/constants/property');
const { INVOICE_STATUS, INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { logActivity } = require('../../dashboard/service/activity.service');
const { logEntityNoteActivity } = require('../../../../../common/services/entityNoteActivity.service');
const { enrichNotesWithAuthors } = require('../../../../../common/helpers/enrichNotesWithAuthors');
const { nextEmbeddedNoteNumber } = require('../../../../../common/helpers/nextEmbeddedNoteNumber');
const { enrichNotesAttachments } = require('../../../../../common/helpers/enrichNoteAttachments');
const { removeAttachmentsFromNote } = require('../../../../../common/helpers/noteAttachmentUpdates');
const ledgerService = require('../../owners/services/ledger.service');
const { getCurrentOwnerIdsFromUnit, resolveOwnershipEffectiveDateForOwner, resolveOwnershipPeriodForOwner } = require('../../owners/services/unit.service');
const logger = require('../../../../../common/logger');
const {
  updateOwnersMailingAddress,
} = require('../../../../../common/helpers/addressHelper');
const { unitDisplayNameFromMaintenance } = require('../../../../../common/helpers/propertyUnitReference');
const {
  formatDateInAppTimezone,
  formatMonthYearInAppTimezone,
  compareCalendarDateToToday,
} = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../../common/date');
const { resolvePropertyBillingTimezoneFields } = require('../../../../../common/helpers/resolvePropertyBillingTimezone');
const { buildHOAOwnerUserFilter } = require('../../../../../common/helpers/hoaOwnerRole');
const { buildOwnerEligibilityFields } = require('../../owners/helpers/ownerEligibility.helper');
const {
  toObjectId,
  normalizeDateToStartOfDay,
} = require('../../../../../common/db/mongooseHelpers');
const {
  OPEN_MAINTENANCE_STATUSES,
  bulkFetchHoaPropertyListData,
  buildUnpaidSummaryMaps,
  countPropertyReferences,
  distinctPropertyIdsWithOpenMaintenance,
  findOverdueInvoicesByProperty,
  findFeeInvoicesForProperty,
  findInvoicesForPropertyDetail,
  findOpenMaintenanceByProperty,
  findActiveListingByProperty,
  aggregateMaintenanceCountsByProperty,
  aggregateUnpaidSummaryByPropertyIds,
} = require('../../../../../common/db/propertyRelatedQueries');

// Aliases for backward compatibility
const INCOME_STATUS = INVOICE_STATUS;
const INCOME_TYPES = INVOICE_TYPES;

/**
 * Property Service with HOA Data Isolation
 * 
 * This service provides comprehensive property management functionality with
 * built-in HOA Board Member data isolation. Key features:
 * 
 * 1. HOA Data Isolation:
 *    - Automatic filtering of properties based on user context
 *    - HOA Board Members only see properties they own (landlord_id match)
 *    - Regular landlords see all their properties
 * 
 * 2. Performance Optimization:
 *    - Bulk data fetching to minimize database queries
 *    - Efficient aggregation for statistics calculation
 *    - Optimized property listing with computed fields
 * 
 * 3. Comprehensive Property Data:
 *    - Unit-level statistics and occupancy tracking
 *    - Maintenance request counts and status
 *    - Financial data (fees, overdue amounts)
 *    - Owner associations and billing status
 */

function formatAddress(address) {
  if (!address) return '';
  return `${address.street || ''}${address.street ? ', ' : ''}${address.city || ''}${address.city ? ', ' : ''}${address.state || ''}${address.zip ? ', ' : ''}${address.zip || ''}${address.country ? ', ' : ''}${address.country || ''}`.replace(/, \s*,/g, ', ');
}

const { getPagination } = require('../../../../../common/helpers/paginationHelper');
const { UPLOAD_PROPERTY_SUBDIR } = require('../../../../../common/constants/uploads');

// Normalize a Date to midnight (start of day) in local time - used for overdue date comparisons
// (normalizeDateToStartOfDay imported from mongooseHelpers)

// small helper to parse loose boolean-like query values into true/false/null
function parseBoolean(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'undefined' || val === null) return null;
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null; // unknown
}

/**
 * format Owner Display Name
 *
 * Performs logic operations for formatOwnerDisplayName.
 *
 * @param owner - Request/input argument
 * @returns Operations result
 */
function formatOwnerDisplayName(owner) {
  if (!owner || typeof owner !== 'object') return 'Unknown';
  const explicitName = String(owner.name || '').trim();
  if (explicitName) return explicitName;
  const fromParts = `${owner.firstName || ''} ${owner.lastName || ''}`.trim();
  if (fromParts) return fromParts;
  return String(owner.email || '').trim() || 'Unknown';
}

function formatPropertyOwnerDto(owner) {
  return {
    id: owner._id,
    name: formatOwnerDisplayName(owner),
    email: owner.email,
    phone: owner.phone,
    ...buildOwnerEligibilityFields(owner),
  };
}

/**
 * assert Hoa Member User Id
 *
 * Performs logic operations for assertHoaMemberUserId.
 *
 * @param userId - Request/input argument
 * @param userContext - Request/input argument
 * @returns Operations result
 */
function assertHoaMemberUserId(userId, userContext) {
  if (!userContext?.isHOABoardMember) return;
  const memberIds = (
    Array.isArray(userContext.hoaMemberUserIds) && userContext.hoaMemberUserIds.length
      ? userContext.hoaMemberUserIds
      : [userContext.userId]
  )
    .map((id) => (id && id.toString ? id.toString() : String(id)))
    .filter(Boolean);
  const targetId = userId && userId.toString ? userId.toString() : String(userId);
  if (!memberIds.includes(targetId)) {
    const err = new Error('Access denied. createdBy must be an active member of your HOA.');
    err.status = 403;
    throw err;
  }
}

/**
 * clone For Storage
 *
 * Performs logic operations for cloneForStorage.
 *
 * @param data - Request/input argument
 * @returns Operations result
 */
function cloneForStorage(data) {
  if (!data || typeof data !== 'object') return data;
  return JSON.parse(JSON.stringify(data));
}

/**
 * merge Bank Account Fields
 *
 * Performs logic operations for mergeBankAccountFields.
 *
 * @param propertyData - Request/input argument
 * @param existingSettings - Request/input argument
 * @returns Operations result
 */
function mergeBankAccountFields(propertyData = {}, existingSettings = {}) {
  const incomingSettings = propertyData.propertySettings || {};
  const existingBank = (existingSettings && existingSettings.bankAccount) || {};
  const incomingBank = (incomingSettings && incomingSettings.bankAccount) || {};

  const mergedBank = {
    ...cloneForStorage(existingBank),
    ...cloneForStorage(incomingBank),
  };

  if (typeof mergedBank.bankName === 'undefined') {
    mergedBank.bankName = incomingSettings.bankName ?? propertyData.bankName ?? mergedBank.bankName;
  }
  if (typeof mergedBank.accountType === 'undefined') {
    mergedBank.accountType = incomingSettings.accountType ?? propertyData.accountType ?? mergedBank.accountType;
  }
  if (typeof mergedBank.routingNumber === 'undefined') {
    mergedBank.routingNumber = incomingSettings.routingNumber ?? propertyData.routingNumber ?? mergedBank.routingNumber;
  }
  if (typeof mergedBank.accountNumber === 'undefined') {
    mergedBank.accountNumber = incomingSettings.accountNumber ?? propertyData.accountNumber ?? mergedBank.accountNumber;
  }
  const existingBankAddress = (existingBank && existingBank.address) || {};
  const incomingBankAddress = (incomingBank && incomingBank.address) || {};
  mergedBank.address = {
    ...cloneForStorage(existingBankAddress),
    ...cloneForStorage(incomingBankAddress),
    line2: typeof incomingBankAddress.line2 !== 'undefined'
      ? incomingBankAddress.line2
      : (typeof incomingBankAddress.addressLine2 !== 'undefined' ? incomingBankAddress.addressLine2 : existingBankAddress.line2),
    addressLine2: typeof incomingBankAddress.addressLine2 !== 'undefined'
      ? incomingBankAddress.addressLine2
      : (typeof incomingBankAddress.line2 !== 'undefined' ? incomingBankAddress.line2 : existingBankAddress.addressLine2),
  };

  const mergedLateFees = Array.isArray(incomingSettings.lateFees)
    ? cloneForStorage(incomingSettings.lateFees)
    : (Array.isArray(existingSettings.lateFees) ? cloneForStorage(existingSettings.lateFees) : []);

  return {
    ...cloneForStorage(existingSettings || {}),
    ...cloneForStorage(incomingSettings || {}),
    bankAccount: mergedBank,
    lateFees: mergedLateFees,
  };
}

/**
 * Get owners associated with a property (HOA units - not lease tenants).
 */
async function getTenantsForProperty(propertyId) {
  try {
    const owners = await getAssociatedOwnersForProperty(propertyId);
    return owners.map((o) => ({
      id: o.id || o._id,
      name: o.name || 'Unknown',
      email: o.email,
      phone: o.phone,
      ownershipEffectiveDate: o.ownershipEffectiveDate || null,
      ownershipEndDate: o.ownershipEndDate || null,
      ownershipStatus: o.ownershipStatus || null,
    }));
  } catch (e) {
    logger.error('Error fetching owners for property:', e);
    return [];
  }
}

/**
 * HOA single-unit properties share owners at property level.
 */
async function getTenantsForUnit(propertyId) {
  return getTenantsForProperty(propertyId);
}

/**
 * Compute maintenance counts for a property (open/closed). Returns { openMaintenance, closedMaintenance }
 */
async function computeMaintenanceCountsForProperty(property) {
  try {
    return await aggregateMaintenanceCountsByProperty(property._id);
  } catch (e) {
    return { openMaintenance: 0, closedMaintenance: 0 };
  }
}

/**
 * Get associated owners for a property from associatedOwnerIds and User.propertyIds
 */
async function getAssociatedOwnersForProperty(propertyId) {
  try {
    const propObjId = toObjectId(propertyId);
    if (!propObjId) return [];
    const ownerRoleFilter = await buildHOAOwnerUserFilter();

    const property = await Property.findById(propObjId).lean();
    if (!property) return [];

    const timelineOwnerIds = getCurrentOwnerIdsFromUnit(property).map((id) => String(id));
    const associatedIds = (property.associatedOwnerIds || []).map((id) => id.toString());
    const hasOwnershipTimeline = Array.isArray(property.ownershipRecords) && property.ownershipRecords.length > 0;

    // Current associations only. Past owners belong in ownershipLogs / ownershipRecords history.
    const currentOwnerIds = hasOwnershipTimeline
      ? timelineOwnerIds
      : (timelineOwnerIds.length > 0 ? timelineOwnerIds : associatedIds);
    const allOwnerIds = currentOwnerIds.map((id) => toObjectId(id)).filter(Boolean);

    if (allOwnerIds.length === 0) {
      return [];
    }

    const owners = await User.find({
      $and: [ownerRoleFilter, { _id: { $in: allOwnerIds } }],
    }).select('firstName lastName email phone').lean();

    // Heal associatedOwnerIds only when timeline produced a non-empty current set.
    // Never wipe stored associations because of a temporary empty timeline evaluation.
    if (timelineOwnerIds.length > 0) {
      const storedOwnerIds = [...associatedIds].sort();
      const nextOwnerIds = [...timelineOwnerIds].sort();
      if (JSON.stringify(storedOwnerIds) !== JSON.stringify(nextOwnerIds)) {
        await Property.findByIdAndUpdate(propObjId, {
          $set: { associatedOwnerIds: timelineOwnerIds.map((id) => toObjectId(id)).filter(Boolean) },
        });
      }
    }

    return owners.map(owner => {
      const period = resolveOwnershipPeriodForOwner(property, owner._id);
      return {
        id: owner._id,
        name: formatOwnerDisplayName(owner),
        email: owner.email,
        phone: owner.phone,
        ownershipEffectiveDate: period.startDate || resolveOwnershipEffectiveDateForOwner(property, owner._id),
        ownershipEndDate: period.endDate || null,
        ownershipStatus: period.status || null,
      };
    });
  } catch (e) {
    logger.error('Error fetching associated owners for property:', e);
    return [];
  }
}

/**
 * Batch-fetch associated owners for multiple properties (list views - no write-on-read sync).
 */
async function batchGetAssociatedOwnersForProperties(propertyIds, preloadedProperties = null) {
  const result = new Map();
  if (!propertyIds || propertyIds.length === 0) return result;

  const propObjIds = propertyIds.map((id) => toObjectId(id)).filter(Boolean);
  const propIdStrings = propObjIds.map((id) => id.toString());

  try {
    const ownerRoleFilter = await buildHOAOwnerUserFilter();

    const properties = preloadedProperties && preloadedProperties.length > 0
      ? preloadedProperties
      : await Property.find({ _id: { $in: propObjIds } })
        .select('_id associatedOwnerIds ownershipRecords createdAt')
        .lean();

    const currentOwnersByProperty = new Map();
    const associatedByProperty = new Map();
    for (const property of properties) {

    // Upload to S3
      const key = property._id.toString();
      currentOwnersByProperty.set(
        key,
        getCurrentOwnerIdsFromUnit(property).map((id) => id.toString())
      );
      associatedByProperty.set(
        key,
        (property.associatedOwnerIds || []).map((id) => id.toString())
      );
    }

    const ownersWithProperty = await User.find({
      $and: [ownerRoleFilter, { propertyIds: { $in: propObjIds } }],
    }).select('firstName lastName email phone propertyIds portalOnboardingStatus status isArchived isDeleted').lean();

    const ownerIdsNeeded = new Set();
    const ownersByPropertyFromUsers = {};
    for (const propId of propIdStrings) {
      ownersByPropertyFromUsers[propId] = new Set();
    }

    for (const owner of ownersWithProperty) {
      if (owner.isDeleted) continue;
      const ownerIdStr = owner._id.toString();
      for (const pid of owner.propertyIds || []) {
        const key = pid.toString();
        if (!ownersByPropertyFromUsers[key]) continue;
        const currentOwnerIds = currentOwnersByProperty.get(key) || [];
        const associatedIds = associatedByProperty.get(key) || [];
        if (
          currentOwnerIds.includes(ownerIdStr)
          || (currentOwnerIds.length === 0 && associatedIds.includes(ownerIdStr))
          || (currentOwnerIds.length === 0 && associatedIds.length === 0)
        ) {
          ownerIdsNeeded.add(ownerIdStr);
          ownersByPropertyFromUsers[key].add(ownerIdStr);
        }
      }
    }

    for (const property of properties) {
      const key = property._id.toString();
      let currentOwnerIds = currentOwnersByProperty.get(key) || [];
      if (currentOwnerIds.length === 0) {
        currentOwnerIds = associatedByProperty.get(key) || [];
        currentOwnersByProperty.set(key, currentOwnerIds);
      }
      if (!ownersByPropertyFromUsers[key]) ownersByPropertyFromUsers[key] = new Set();
      for (const oid of currentOwnerIds) {
        ownerIdsNeeded.add(oid);
        ownersByPropertyFromUsers[key].add(oid);
      }
    }

    const ownerById = new Map(
      ownersWithProperty.map((o) => [o._id.toString(), formatPropertyOwnerDto(o)])
    );

    const missingOwnerIds = Array.from(ownerIdsNeeded)
      .filter((id) => !ownerById.has(id))
      .map(toObjectId)
      .filter(Boolean);
    if (missingOwnerIds.length > 0) {
      const extraOwners = await User.find({
        $and: [ownerRoleFilter, { _id: { $in: missingOwnerIds } }],
      }).select('firstName lastName email phone portalOnboardingStatus status isArchived isDeleted').lean();
      for (const o of extraOwners) {
        ownerById.set(o._id.toString(), formatPropertyOwnerDto(o));
      }
    }

    for (const propId of propIdStrings) {
      const ids = ownersByPropertyFromUsers[propId] || new Set();
      const property = properties.find((p) => String(p._id) === propId);
      result.set(
        propId,
        Array.from(ids)
          .map((id) => {
            const base = ownerById.get(id);
            if (!base) return null;
            const period = property
              ? resolveOwnershipPeriodForOwner(property, id)
              : { startDate: null, endDate: null, status: null };
            return {
              ...base,
              ownershipEffectiveDate: period.startDate || (property
                ? resolveOwnershipEffectiveDateForOwner(property, id)
                : null),
              ownershipEndDate: period.endDate || null,
              ownershipStatus: period.status || null,
            };
          })
          .filter(Boolean)
      );
    }
  } catch (e) {
    logger.error('Error batch-fetching associated owners:', e);
    for (const propId of propertyIds) {
      result.set(String(propId), []);
    }
  }

  return result;
}

/**
 * Get properties with optional filters and pagination.
 * 
 * This is the main property listing service with comprehensive filtering,
 * sorting, and HOA data isolation support. Features:
 * 
 * Supported Query Parameters:
 * - page, pageSize: Pagination controls
 * - sortBy, order/sortOrder: Sorting configuration
 * - status: Property occupancy status filtering
 * - name, city, state, zip: Text-based property filtering
 * - numberOfUnits: Exact unit count filtering (API still supports; listing UI no longer exposes it)
 * - hasOpenMaintenance: Boolean maintenance status filtering
 * - rentStatus, maintenance: Computed field filtering
 * - search: Property name, unit name/number, address, and owner details (case-insensitive)
 * 
 * HOA Data Isolation:
 * - Automatically applies HOA filtering when userContext indicates HOA Board Member
 * - Uses applyHOADataFilter() to restrict data access
 * - Ensures complete data segregation between HOA Board Members
 * 
 * Performance Features:
 * - Bulk data fetching for related entities (invoices, maintenance, owners)
 * - Efficient aggregation and computation of property statistics
 * - Optimized database queries with proper indexing
 * 
 * @param {Object} query - Query parameters for filtering and pagination
 * @param {Object} userContext - HOA user context for data isolation (optional)
 * @returns {Object} - Paginated property results with computed statistics
 */
async function getPropertiesService(query, userContext = null) {
  const t0 = Date.now();
  const {
    pageNumber = 1,
    pageSize,
    sortBy,
    order = 'asc',
    sortOrder,
    status,
    rentStatus,
    maintenance,
    search,
  } = query;

  // Use sortOrder if provided, otherwise fall back to order
  const sortDirection = sortOrder || order || 'asc';

  const { name, city, state: addrState, zip, numberOfUnits } = query;
  const hasOpenMaintenance = parseBoolean(query.hasOpenMaintenance);
  const showArchived = parseBoolean(query.showArchived);

  // Always hide soft-deleted units. Archived vs active is controlled by showArchived.
  let filter = {
    isDeleted: { $ne: true },
    ...(showArchived === true
      ? { isArchieved: true }
      : { isArchieved: { $ne: true } }),
  };

  if (query.createdBy) {
    assertHoaMemberUserId(query.createdBy, userContext);
    filter.landlord_id = query.createdBy;
  } else if (query.landlordId && !(userContext && userContext.isHOABoardMember && userContext.hoaId)) {
    filter.landlord_id = query.landlordId;
  }

  // Apply HOA data isolation - This is the key integration point
  // The applyHOADataFilter function automatically adds filtering conditions
  // for HOA Board Members to ensure they only see their own properties
  filter = applyHOADataFilter(filter, userContext);

  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name) filter.name = { $regex: escapeRegex(name), $options: 'i' };
  if (city) filter['address.city'] = { $regex: escapeRegex(city), $options: 'i' };
  if (addrState) filter['address.state'] = { $regex: escapeRegex(addrState), $options: 'i' };
  if (zip) filter['address.zip'] = { $regex: escapeRegex(zip), $options: 'i' };
  // Merge text search under $and so it cannot collide with HOA isolation `$or`/`$and`.
  // Owner name search resolves User records and matches associatedOwnerIds / propertyIds
  // so co-owners and partial full-name queries are not limited to Property.ownerName.
  const {
    mergeSearchClauseIntoFilter,
    buildPropertyTextSearchClauseWithOwners,
  } = require('../helpers/propertyListSearch.helper');
  mergeSearchClauseIntoFilter(
    filter,
    await buildPropertyTextSearchClauseWithOwners(search, escapeRegex),
  );

  if (typeof numberOfUnits !== 'undefined') {
    const n = parseInt(numberOfUnits, 10);
    if (!Number.isNaN(n)) {
      // Align with list display: empty unitDetails is treated as 1 unit.
      filter.$expr = {
        $eq: [
          {
            $let: {
              vars: { unitSize: { $size: { $ifNull: ['$unitDetails', []] } } },
              in: { $cond: [{ $gt: ['$$unitSize', 0] }, '$$unitSize', 1] },
            },
          },
          n,
        ],
      };
    }
  }

  const propertyProjection = {
    _id: 1,
    landlord_id: 1,
    hoaId: 1,
    name: 1,
    address: 1,
    'unitDetails._id': 1,
    'unitDetails.unitName': 1,
    'images.metadataId': 1,
    profileImageId: 1,
    status: 1,
    notes: 1,
    startingBalance: 1,
    remainingCredit: 1,
    monthlyRecurringFee: 1,
    associatedOwnerIds: 1,
    ownershipRecords: 1,
    isArchieved: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  // Build sort object for MongoDB query
  let sortObj = {};
  if (sortBy) {
    const direction = sortDirection && sortDirection.toLowerCase() === 'desc' ? -1 : 1;
    sortObj[sortBy] = direction;
  }

  const resolveScopedPropertyIds = async () => {
    if (filter._id?.$in) return filter._id.$in;
    return Property.find(filter).select('_id').lean().then((rows) => rows.map((p) => p._id));
  };

  const needsPostEnrichmentFilters = false;

  const { offset, limit: effectiveLimit, page: pageNum, pageSize: pageSizeNum } = getPagination({ page: pageNumber, pageSize });

  const OPEN_MAINTENANCE_STATUSES_LOCAL = OPEN_MAINTENANCE_STATUSES;

  // Pre-filter by overdue/on-time rent at Mongo level (avoids loading entire HOA for rentStatus filter)
  if (rentStatus) {
    const rentLower = String(rentStatus).toLowerCase();
    const isOverdue = rentLower === 'overdue';
    const isOntime = rentLower === 'ontime' || rentLower === 'on time';
    if (isOverdue || isOntime) {
      const scopedIds = filter._id?.$in
        ? filter._id.$in
        : await Property.find(filter).select('_id').lean().then((rows) => rows.map((p) => p._id));
      if (scopedIds.length === 0) {
        return { total: 0, page: pageNum, pagesize: effectiveLimit || pageSize || 10, data: [] };
      }
      const today = DateUtil.startOfDayEST(ClockService.now());
      const unpaidSummary = await aggregateUnpaidSummaryByPropertyIds(scopedIds, today);
      const { pastDueByProperty, unpaidTotalByProperty } = buildUnpaidSummaryMaps(unpaidSummary);
      const overdueIds = scopedIds.filter((id) => {
        const propId = id.toString();
        const amount = pastDueByProperty[propId] || unpaidTotalByProperty[propId] || 0;
        return amount > 0;
      });
      if (isOverdue) {
        filter._id = { $in: overdueIds };
      } else {
        filter._id = {
          $in: scopedIds.filter((id) => !overdueIds.some((oid) => String(oid) === String(id))),
        };
      }
    }
  }

  // Pre-filter by maintenance open/closed counts at Mongo level
  if (maintenance) {
    const maintLower = String(maintenance).toLowerCase();
    const isOpen = maintLower === 'open';
    const isClosed = maintLower === 'closed';
    if (isOpen || isClosed) {
      const scopedIds = await resolveScopedPropertyIds();
      if (scopedIds.length === 0) {
        return { total: 0, page: pageNum, pagesize: effectiveLimit || pageSize || 10, data: [] };
      }
      const maintCounts = await aggregateMaintenanceCountsByPropertyIds(scopedIds);
      const matchingIds = maintCounts
        .filter((row) => (isOpen ? (row.open || 0) > 0 : (row.closed || 0) > 0))
        .map((row) => row._id);
      filter._id = { $in: matchingIds };
    }
  }

  // HOA occupancy filter: vacant/occupied uses associatedOwnerIds, not leases.
  // Unlike the landlord portal (active lease records), a unit is occupied when at
  // least one owner is linked on the property; vacant when associatedOwnerIds is empty.
  if (status) {
    const statusLower = String(status).toLowerCase();
    if (statusLower === 'vacant' || statusLower === 'occupied') {
      const scopedIds = await resolveScopedPropertyIds();
      if (scopedIds.length === 0) {
        return { total: 0, page: pageNum, pagesize: effectiveLimit || pageSize || 10, data: [] };
      }
      const ownerRows = await Property.find({ _id: { $in: scopedIds } })
        .select('_id associatedOwnerIds')
        .lean();
      const matchingIds = ownerRows
        .filter((row) => {
          // HOA occupancy is owner-based (not lease-based): a unit is occupied when it
          // has at least one entry in associatedOwnerIds, vacant otherwise.
          const hasOwners = Array.isArray(row.associatedOwnerIds) && row.associatedOwnerIds.length > 0;
          return statusLower === 'occupied' ? hasOwners : !hasOwners;
        })
        .map((row) => row._id);
      filter._id = { $in: matchingIds };
    }
  }

  // Pre-filter by open maintenance at Mongo level when requested
  if (hasOpenMaintenance === true || hasOpenMaintenance === false) {
    const scopedIds = await Property.find(filter).select('_id').lean().then((rows) => rows.map((p) => p._id));
    if (scopedIds.length === 0) {
      return { total: 0, page: pageNum, pagesize: effectiveLimit || pageSize || 10, data: [] };
    }
    const openPropIds = await distinctPropertyIdsWithOpenMaintenance(scopedIds, OPEN_MAINTENANCE_STATUSES_LOCAL);
    if (hasOpenMaintenance === true) {
      filter._id = { $in: openPropIds };
    } else {
      filter._id = { $in: scopedIds.filter((id) => !openPropIds.some((openId) => String(openId) === String(id))) };
    }
  }

  let properties;
  let totalPreFiltered;
  const paginateAtDatabase = !needsPostEnrichmentFilters;

  if (paginateAtDatabase) {
    [totalPreFiltered, properties] = await Promise.all([
      Property.countDocuments(filter).exec(),
      Property.find(filter, propertyProjection)
        .sort(sortObj)
        .skip(offset)
        .limit(effectiveLimit || 0)
        .lean()
        .exec(),
    ]);
  } else {
    properties = await Property.find(filter, propertyProjection).sort(sortObj).lean();
    if (typeof numberOfUnits !== 'undefined') {
      const n = parseInt(numberOfUnits, 10);
      if (!Number.isNaN(n)) {
        properties = properties.filter((p) => {
          const unitSize = Array.isArray(p.unitDetails) ? p.unitDetails.length : 0;
          const effectiveUnitCount = unitSize > 0 ? unitSize : 1;
          return effectiveUnitCount === n;
        });
      }
    }
  }

  const propertyIds = properties.map(p => toObjectId(p._id));

  if (propertyIds.length === 0) {
    return {
      total: 0,
      page: pageNumber,
      pagesize: pageSize || 10,
      data: [],
    };
  }

  const t1 = Date.now();
  const today = DateUtil.startOfDayEST(ClockService.now());
  const propertyIdStrings = propertyIds.map((id) => String(id));

  const [
    { allMaintenanceCounts, unpaidSummary },
    ownersByProperty,
    balanceSummaries,
  ] = await Promise.all([
    bulkFetchHoaPropertyListData(propertyIds, today),
    batchGetAssociatedOwnersForProperties(propertyIdStrings, properties),
    ledgerService.getBalanceSummariesBatch(propertyIdStrings, { readOnly: true }),
  ]);
  logger.info(`[PERF] Parallel bulk fetch+owners+balances: ${Date.now() - t1}ms`);

  const t2 = Date.now();
  const {
    overdueByProperty,
    pastDueByProperty,
    unpaidTotalByProperty,
    dueTodayByProperty,
    overdueByPropertyUnit,
  } = buildUnpaidSummaryMaps(unpaidSummary);

  const maintenanceByProperty = {};
  for (let i = 0; i < allMaintenanceCounts.length; i++) {
    const row = allMaintenanceCounts[i];
    maintenanceByProperty[row._id.toString()] = { open: row.open || 0, closed: row.closed || 0 };
  }
  logger.info(`[PERF] Build lookup maps: ${Date.now() - t2}ms`);

  const t4 = Date.now();
  const entries = [];

  for (let pi = 0; pi < properties.length; pi++) {
    const p = properties[pi];
    const propId = p._id.toString();
    const unitDetails = p.unitDetails || [];
    const maintCounts = maintenanceByProperty[propId] || { open: 0, closed: 0 };
    const propertyOwners = ownersByProperty.get(propId) || [];
    const hasOwners = propertyOwners.length > 0;
    const monthlyFee = Number(p.monthlyRecurringFee) || 0;

    const currentTotalDue = unpaidTotalByProperty[propId] || 0;
    const summaryBalance = ledgerService.portfolioDisplayBalanceFromSummary(
      balanceSummaries[propId]
    );
    const dueTodayAmount = summaryBalance.dueTodayAmount || dueTodayByProperty[propId] || 0;
    const creditBalance = summaryBalance.creditBalance;
    const pastDueAmount = summaryBalance.pastDueAmount || pastDueByProperty[propId] || 0;
    const overdueAmount = pastDueAmount;
    const netBalance = summaryBalance.netBalance;

    const units = [];
    let totalAmountOverdue = 0;
    let occupiedUnits = 0;

    if (unitDetails.length > 0) {
      for (let ui = 0; ui < unitDetails.length; ui++) {
        const ud = unitDetails[ui];
        const unitName = ud.unitName || '';
        const unitNameLower = unitName.toLowerCase();
        const unitAmountOverdue = overdueByPropertyUnit[`${propId}::${unitNameLower}`] || 0;
        const isOccupied = hasOwners;
        if (isOccupied) occupiedUnits++;

        totalAmountOverdue += unitAmountOverdue || 0;
        units.push({
          unitId: ud._id ? ud._id.toString() : `unit_${unitName.replace(/\s+/g, '_').toLowerCase()}`,
          unitName,
          fees: monthlyFee,
          monthlyRecurringFee: monthlyFee,
          amountOverdue: unitAmountOverdue || 0,
          hoaOccupancyStatus: isOccupied ? 'Occupied' : 'Vacant',
          openMaintenance: 0,
          closedMaintenance: 0,
          recurringFeesEndDate: null,
          owners: propertyOwners,
          hasActiveOwner: hasOwners,
        });
      }
    } else {
      const unitAmountOverdue = unpaidTotalByProperty[propId] || 0;
      const isOccupied = hasOwners;
      if (isOccupied) occupiedUnits++;
      totalAmountOverdue = unitAmountOverdue || 0;
      units.push({
        unitId: 'unit_001',
        unitName: p.unitDetails?.[0]?.unitName || 'Unit 1',
        fees: monthlyFee,
        monthlyRecurringFee: monthlyFee,
        amountOverdue: unitAmountOverdue || 0,
        hoaOccupancyStatus: isOccupied ? 'Occupied' : 'Vacant',
        openMaintenance: 0,
        closedMaintenance: 0,
        recurringFeesEndDate: null,
        owners: propertyOwners,
        hasActiveOwner: hasOwners,
      });
    }

    const unitsCount = Math.max(units.length, 1);
    const openPerUnit = Math.floor(maintCounts.open / unitsCount);
    const closedPerUnit = Math.floor(maintCounts.closed / unitsCount);
    // Distribute property-level maintenance counts across unit rows for display.
    // Floor division plus remainder to the first N units (e.g. 7 open / 3 units → 3,2,2)
    // so per-unit values always sum to the property total (maintCounts.open/closed).
    for (let ui = 0; ui < units.length; ui++) {
      units[ui].openMaintenance = openPerUnit + (ui < (maintCounts.open % unitsCount) ? 1 : 0);
      units[ui].closedMaintenance = closedPerUnit + (ui < (maintCounts.closed % unitsCount) ? 1 : 0);
    }

    const occupancyStatus = hasOwners ? 'Occupied' : 'Vacant';
    const billingCycleStatus = hasOwners ? 'Active' : '-';
    let overallStatus = 'Vacant';
    if (occupiedUnits === units.length && units.length > 0) {
      overallStatus = 'Fully Occupied';
    } else if (occupiedUnits > 0) {
      overallStatus = 'Partially Occupied';
    }

    entries.push({
      ...p,
      totalRent: monthlyFee,
      totalAmountOverdue,
      currentTotalDue,
      dueTodayAmount,
      creditBalance,
      pastDueAmount,
      overdueAmount,
      netBalance,
      totalOpenMaintenance: maintCounts.open,
      totalClosedMaintenance: maintCounts.closed,
      totalUnits: units.length,
      occupiedUnits,
      vacantUnits: units.length - occupiedUnits,
      overallStatus,
      billingCycleStatus,
      occupancyStatus,
      units,
    });
  }
  logger.info(`[PERF] Process properties: ${Date.now() - t4}ms`);

  let filtered = entries;

  if (status) {
    const statusLower = status.toLowerCase();
    if (statusLower === 'vacant' || statusLower === 'occupied') {
      filtered = filtered.filter((f) => (f.occupancyStatus || '').toLowerCase() === statusLower);
    }
  }

  if (rentStatus) {
    const isOverdue = rentStatus.toLowerCase() === 'overdue';
    const isOntime = rentStatus.toLowerCase() === 'ontime' || rentStatus.toLowerCase() === 'on time';
    if (isOverdue) filtered = filtered.filter(f => (f.totalAmountOverdue || 0) > 0);
    if (isOntime) filtered = filtered.filter(f => (f.totalAmountOverdue || 0) === 0);
  }
  if (maintenance) {
    const isOpen = maintenance.toLowerCase() === 'open';
    const isClosed = maintenance.toLowerCase() === 'closed';
    if (isOpen) filtered = filtered.filter(f => (f.totalOpenMaintenance || 0) > 0);
    if (isClosed) filtered = filtered.filter(f => (f.totalClosedMaintenance || 0) > 0);
  }
  if (hasOpenMaintenance !== null) {
    if (hasOpenMaintenance === true) filtered = filtered.filter(f => (f.totalOpenMaintenance || 0) > 0);
    if (hasOpenMaintenance === false) filtered = filtered.filter(f => (f.totalOpenMaintenance || 0) === 0);
  }

  let total;
  let paged;

  if (paginateAtDatabase) {
    total = totalPreFiltered;
    paged = filtered;
  } else {
    total = filtered.length;
    if (typeof pageSizeNum !== 'undefined' && pageSizeNum === 0) {
      return { total, page: pageNum, pagesize: 0, data: [] };
    }
    paged = effectiveLimit === 0 ? filtered : filtered.slice(offset, offset + effectiveLimit);
  }

  if (typeof pageSizeNum !== 'undefined' && pageSizeNum === 0) {
    return { total, page: pageNum, pagesize: 0, data: [] };
  }

  const data = [];
  const documentsService = require('../../../../../shared/modules/documents/service/documents.service');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');

  // Batch-resolve first image URL for list cards (avoids Unsplash placeholders)
  const firstImageMetaIds = [];
  for (let i = 0; i < paged.length; i++) {
    const imgs = paged[i].images || [];
    const first = imgs.find((img) => img && img.metadataId);
    if (first?.metadataId) firstImageMetaIds.push(first.metadataId);
  }
  const uniqueMetaIds = [...new Set(firstImageMetaIds.map((id) => String(id)))]
    .map(toObjectId)
    .filter(Boolean);
  const metaById = new Map();
  if (uniqueMetaIds.length > 0) {
    const metas = await DocumentMetadata.find({ _id: { $in: uniqueMetaIds } }).lean();
    for (const m of metas) metaById.set(String(m._id), m);
  }

  for (let i = 0; i < paged.length; i++) {
    const p = paged[i];
    const owners = ownersByProperty.get(String(p._id)) || [];
    const firstImg = (p.images || []).find((img) => img && img.metadataId);
    let imageUrl = null;
    if (firstImg?.metadataId) {
      const meta = metaById.get(String(firstImg.metadataId));
      if (meta) {
        imageUrl = documentsService.buildPublicUrl(meta);
      }
    }
    data.push({
      id: p._id,
      hoaBoardMemberId: p.landlord_id,
      hoaId: p.hoaId,
      name: p.name,
      // address: formatAddress(p.address),
      address: p.address.street || {},
      city: p.address?.city || '',
      state: p.address?.state || '',
      zip: p.address?.zip || '',
      image: imageUrl,
      images: imageUrl ? [imageUrl] : [],
      totalFees: p.totalRent || 0,
      totalAmountOverdue: p.totalAmountOverdue || 0,
      currentTotalDue: p.currentTotalDue || 0,
      creditBalance: p.creditBalance || 0,
      pastDueAmount: p.pastDueAmount || p.overdueAmount || 0,
      overdueAmount: p.overdueAmount || 0,
      dueTodayAmount: p.dueTodayAmount || 0,
      netBalance: p.netBalance ?? 0,
      billingCycleStatus: p.billingCycleStatus || '-',
      hoaOccupancyStatus: p.occupancyStatus || 'Vacant',
      totalOpenMaintenance: p.totalOpenMaintenance || 0,
      totalClosedMaintenance: p.totalClosedMaintenance || 0,
      totalUnits: p.totalUnits || 0,
      occupiedUnitCount: p.occupiedUnits || 0,
      vacantUnitCount: p.vacantUnits || 0,
      units: p.units || [],
      unitDetails: (p.unitDetails || []).map((unit) => ({
        _id: unit?._id,
        unitName: unit?.unitName || '',
      })),
      notesCount: Array.isArray(p.notes) ? p.notes.length : 0,
      startingBalance: p.startingBalance || 0,
      remainingCredit: p.remainingCredit || 0,
      owners: owners || [],
      isArchieved: p.isArchieved || false,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    });
  }

  logger.info(`[PERF] Total getPropertiesService: ${Date.now() - t0}ms`);

  return {
    total,
    page: pageNum,
    pagesize: effectiveLimit,
    data,
  };
}

// Archive (soft-delete) a property by setting isArchieved = true
async function archivePropertyService(propertyId, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  const doArchive = async (session) => {
    const findOpts = {};
    if (session) findOpts.session = session;
    const prop = await Property.findById(propertyId, null, findOpts);
    if (!prop) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }
    prop.isArchieved = true;
    const saveOpts = {};
    if (session) saveOpts.session = session;
    const saved = await prop.save(saveOpts);
    await ledgerService.softDeleteFutureUnpaidInvoices(
      propertyId,
      options.userId || saved.landlord_id,
      session
    );
    const result = saved.toObject();
    await logActivity({
      userId: options.userId || result.landlord_id,
      action: 'ARCHIVE',
      module: 'Property',
      entityId: result._id,
      entityName: result.name,
      description: `Archived property "${result.name}"`,
      meta: { address: result.address }
    });
    return result;
  };

  if (options.session) return doArchive(options.session);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await doArchive(session);
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
}

// Unarchive a property by setting isArchieved = false
async function unarchivePropertyService(propertyId, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  const doUnarchive = async (session) => {
    const findOpts = {};
    if (session) findOpts.session = session;
    const prop = await Property.findById(propertyId, null, findOpts);
    if (!prop) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }
    prop.isArchieved = false;
    const saveOpts = {};
    if (session) saveOpts.session = session;
    const saved = await prop.save(saveOpts);
    const result = saved.toObject();
    await logActivity({
      userId: options.userId || result.landlord_id,
      action: 'RESTORE',
      module: 'Property',
      entityId: result._id,
      entityName: result.name,
      description: `Unarchived property "${result.name}"`,
      meta: { address: result.address }
    });
    return result;
  };

  if (options.session) return doUnarchive(options.session);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await doUnarchive(session);
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
}

async function uploadPropertyNoteFiles(propertyId, files = []) {
  const { uploadNoteAttachmentFiles } = require('../../../../../common/helpers/uploadNoteAttachments');
  return uploadNoteAttachmentFiles({
    entityType: 'property',
    entityId: propertyId,
    files,
  });
}

// Add a note to a property, with file uploads
async function addNoteToPropertyService(propertyId, noteData, files = [], userId) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  const description = String(noteData?.description || '').trim();
  if (!description && (!files || files.length === 0)) {
    throw Object.assign(new Error('description is required'), { status: 400 });
  }

  const uploadedMetaIds = await uploadPropertyNoteFiles(propertyId, files);
  const prop = await Property.findById(propertyId);
  if (!prop) throw Object.assign(new Error('Property not found'), { status: 404 });
  prop.notes = prop.notes || [];
  const now = ClockService.now();
  const newNote = {
    description: description || 'Attachment added.',
    noteNumber: nextEmbeddedNoteNumber(prop.notes),
    attachments: uploadedMetaIds,
    isPinned: Boolean(noteData.isPinned),
    isImportant: Boolean(noteData.isImportant),
    reminder: noteData.reminder ? DateUtil.toUTC(noteData.reminder) : undefined,
    reminderNotifiedAt: undefined,
    createdBy: userId || undefined,
    updatedBy: userId || undefined,
    createdAt: now,
    updatedAt: now,
  };

  if (noteData.title) newNote.title = noteData.title;

  prop.notes.push(newNote);
  // Also add each uploadedMetaId to images array to satisfy schema
  prop.images = prop.images || [];
  for (const metaId of uploadedMetaIds) {
    if (metaId) {
      prop.images.push({ metadataId: metaId });
    }
  }
  // Remove any invalid image objects
  prop.images = prop.images.filter(img => img && img.metadataId);
  await prop.save();

  const savedNote = prop.notes[prop.notes.length - 1];
  if (userId && savedNote) {
    await logEntityNoteActivity({
      userId,
      module: 'Property',
      entityId: prop._id,
      entityName: prop.name || 'Property',
      action: 'created',
      noteTitle: savedNote.title,
      notePreview: savedNote.description,
    });
    if (savedNote.reminder) {
      await logEntityNoteActivity({
        userId,
        module: 'Property',
        entityId: prop._id,
        entityName: prop.name || 'Property',
        action: 'reminder_set',
        noteTitle: savedNote.title,
        notePreview: savedNote.description,
        meta: { reminder: savedNote.reminder },
      });
    }
  }

  prop.notes = await enrichNotesWithAuthors(prop.notes || []);
  prop.notes = await enrichNotesAttachments(prop.notes || []);
  return prop;
}

// Update a note in a property
async function updateNoteInPropertyService(propertyId, noteId, noteData, userId, files = []) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!noteId) throw Object.assign(new Error('noteId is required'), { status: 400 });

  const prop = await Property.findById(propertyId);
  if (!prop) throw Object.assign(new Error('Property not found'), { status: 404 });

  const note = prop.notes.id(noteId);
  if (!note) throw Object.assign(new Error('Note not found'), { status: 404 });

  const prevPinned = Boolean(note.isPinned);
  const prevImportant = Boolean(note.isImportant);
  const prevReminder = note.reminder ? DateUtil.toEpoch(note.reminder) : null;

  if (noteData.description !== undefined) note.description = String(noteData.description || '').trim();
  if (noteData.title !== undefined) note.title = noteData.title;
  if (typeof noteData.isPinned === 'boolean') note.isPinned = noteData.isPinned;
  if (typeof noteData.isImportant === 'boolean') note.isImportant = noteData.isImportant;
  if (noteData.reminder !== undefined) {
    note.reminder = noteData.reminder ? DateUtil.toUTC(noteData.reminder) : null;
    note.reminderNotifiedAt = null;
  }

  const removedAttachmentIds = await removeAttachmentsFromNote(note, noteData.removeAttachmentIds);
  if (removedAttachmentIds.length > 0) {
    const removedSet = new Set(removedAttachmentIds.map(String));
    prop.images = (prop.images || []).filter((img) => !removedSet.has(String(img?.metadataId)));
  }

  const uploadedMetaIds = await uploadPropertyNoteFiles(propertyId, files);
  if (uploadedMetaIds.length > 0) {
    note.attachments = [...(note.attachments || []), ...uploadedMetaIds];
    prop.images = prop.images || [];
    for (const metaId of uploadedMetaIds) {
      if (metaId) prop.images.push({ metadataId: metaId });
    }
    prop.images = prop.images.filter((img) => img && img.metadataId);
  }

  const hasDescription = Boolean(String(note.description || '').trim());
  const hasAttachments = Array.isArray(note.attachments) && note.attachments.length > 0;
  if (!hasDescription && !hasAttachments) {
    throw Object.assign(new Error('Note description or at least one attachment is required'), { status: 400 });
  }
  if (!hasDescription && hasAttachments) {
    note.description = 'Attachment added.';
  }

  if (userId) note.updatedBy = userId;
  note.updatedAt = ClockService.now();

  await prop.save();
  prop.notes = await enrichNotesWithAuthors(prop.notes || []);
  prop.notes = await enrichNotesAttachments(prop.notes || []);

  if (userId) {
    const entityName = prop.name || 'Property';
    const contentChanged =
      noteData.description !== undefined ||
      noteData.title !== undefined ||
      removedAttachmentIds.length > 0 ||
      uploadedMetaIds.length > 0;

    if (typeof noteData.isPinned === 'boolean' && noteData.isPinned !== prevPinned) {
      await logEntityNoteActivity({
        userId,
        module: 'Property',
        entityId: prop._id,
        entityName,
        action: noteData.isPinned ? 'pinned' : 'unpinned',
        noteTitle: note.title,
        notePreview: note.description,
      });
    }
    if (typeof noteData.isImportant === 'boolean' && noteData.isImportant !== prevImportant) {
      await logEntityNoteActivity({
        userId,
        module: 'Property',
        entityId: prop._id,
        entityName,
        action: noteData.isImportant ? 'important' : 'unimportant',
        noteTitle: note.title,
        notePreview: note.description,
      });
    }
    if (contentChanged) {
      await logEntityNoteActivity({
        userId,
        module: 'Property',
        entityId: prop._id,
        entityName,
        action: 'updated',
        noteTitle: note.title,
        notePreview: note.description,
      });
    }
    if (noteData.reminder !== undefined) {
      const nextReminder = note.reminder ? DateUtil.toEpoch(note.reminder) : null;
      await logEntityNoteActivity({
        userId,
        module: 'Property',
        entityId: prop._id,
        entityName,
        action: nextReminder ? (prevReminder ? 'reminder_updated' : 'reminder_set') : 'reminder_cleared',
        noteTitle: note.title,
        notePreview: note.description,
        meta: { reminder: note.reminder },
      });
    }
  }

  return prop;
}

// Delete a note from a property
async function deleteNoteFromPropertyService(propertyId, noteId, userId) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!noteId) throw Object.assign(new Error('noteId is required'), { status: 400 });

  const prop = await Property.findById(propertyId);
  if (!prop) throw Object.assign(new Error('Property not found'), { status: 404 });

  const noteIndex = prop.notes.findIndex(n => n._id.toString() === noteId);
  if (noteIndex === -1) throw Object.assign(new Error('Note not found'), { status: 404 });

  const removed = prop.notes[noteIndex];
  if (userId && removed) {
    await logEntityNoteActivity({
      userId,
      module: 'Property',
      entityId: prop._id,
      entityName: prop.name || 'Property',
      action: 'deleted',
      noteTitle: removed.title,
      notePreview: removed.description,
    });
  }

  prop.notes.splice(noteIndex, 1);
  await prop.save();
  prop.notes = await enrichNotesWithAuthors(prop.notes || []);
  return prop;
}

// CSV import: focus only on core fields now but keep extensible
/**
 * Import properties from CSV.
 * Accepts either:
 *  - filePath: string path to a local file
 *  - fileObj: multer file object (has `path` when stored to disk, or `buffer` when using memoryStorage)
 *
 * This makes the service flexible so controllers can pass the multer file directly.
 */
// Simple but reasonably safe CSV parser that supports quoted fields and escaped quotes ("" -> ")
function parseCsvWithSimpleSplit(content) {
  if (!content) return { header: [], rows: [] };
  // Normalize line endings and split lines, ignore empty lines
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return { header: [], rows: [] };

  // Parse a single CSV line into fields
  function parseLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // handle escaped quotes
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  const headerFields = parseLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headerFields.length; j++) {
      const key = headerFields[j] || `col${j}`;
      obj[key] = (typeof parsed[j] === 'undefined') ? '' : parsed[j].trim();
    }
    rows.push(obj);
  }

  return { header: headerFields, rows };
}

async function importPropertiesFromCsv(fileObj, landlordId) {
  const fs = require('fs');

  // fileObj must be the multer file object (memory buffer or stream). We intentionally
  // require an object input because callers will POST multipart/form-data.
  if (!fileObj || typeof fileObj !== 'object') throw Object.assign(new Error('file (multer file object) is required'), { status: 400 });
  if (!landlordId) throw Object.assign(new Error('landlordId is required'), { status: 400 });
  if (!mongoose.Types.ObjectId.isValid(landlordId)) throw Object.assign(new Error('landlordId is not a valid id'), { status: 400 });

  let content;
  try {
    // Preferred: multer memoryStorage provides `buffer`
    if (fileObj.buffer && Buffer.isBuffer(fileObj.buffer)) {
      content = fileObj.buffer.toString('utf8');
    } else if (fileObj.stream && typeof fileObj.stream.read === 'function') {
      // stream: read into string
      content = await new Promise((resolve, reject) => {
        let data = '';
        fileObj.stream.setEncoding('utf8');
        fileObj.stream.on('data', (chunk) => { data += chunk; });
        fileObj.stream.on('end', () => resolve(data));
        fileObj.stream.on('error', (err) => reject(err));
      });
    } else {
      // We do NOT accept string file paths here per requirement.
      throw new Error('Unsupported file object: expected multer file with buffer or stream');
    }
  } catch (e) {
    throw Object.assign(new Error('Failed to read uploaded file: ' + (e && e.message ? e.message : String(e))), { status: 400 });
  }

  const { header, rows } = parseCsvWithSimpleSplit(content);
  if (!header || rows.length === 0) return { totalRows: 0, created: [], failed: [] };

  const created = [];
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const csvRow = rows[i];
    // Map only allowed core fields; collect others into additionalFields for future use
    const propertyData = mapCsvRowToCorePropertyData(csvRow);

    try {
      const createdProp = await createPropertyService(propertyData, landlordId);
      created.push({ row: i + 1, property: createdProp });
    } catch (e) {
      failed.push({ row: i + 1, error: e && e.message ? e.message : String(e) });
    }
  }

  return { totalRows: rows.length, created, failed };
}

/**
 * Map CSV row to core property payload. Only maps the following fields when present:
 * - name
 * - type
 * - address: street, city, state, country, zip
 * - contactName
 * - contactEmail
 * - contactPhone
 * Any other columns are preserved under `additionalFields` to make the importer extensible.
 */
function mapCsvRowToCorePropertyData(row) {
  const r = row || {};
  const propertyData = {};

  // core fields (per your request)
  propertyData.name = r.name || r.propertyName || r.property_name || '';
  // Support both 'propertyType' (new) and legacy 'type' CSV headers
  propertyData.propertyType = r.propertyType || r.property_type || r.type || '';
  // keep legacy field for backward compatibility inside service
  propertyData.type = propertyData.propertyType;
  propertyData.address = {
    street: r.street || r['street'] || r.address_street || r['address.street'] || r.address || '',
    city: r.city || r['city'] || r.address_city || r['address.city'] || '',
    state: r.state || r['state'] || r.address_state || r['address.state'] || '',
    zip: r.zip || r['zip'] || r.address_zip || r['address.zip'] || '',
    country: r.country || r['country'] || r.address_country || r['address.country'] || '',
  };
  propertyData.ownerName = r.ownerName || r.owner_name || r.contactName || r.contact_name || r.contact || '';
  propertyData.ownerEmail = r.ownerEmail || r.owner_email || r.contactEmail || r.contact_email || r.email || '';
  propertyData.ownerPhone = r.ownerPhone || r.owner_phone || r.contactPhone || r.contact_phone || r.phone || '';
  // new fields supported by schema
  propertyData.description = r.description || r.propertyDescription || r.property_description || '';
  propertyData.ownershipType = r.ownershipType || r.ownership_type || '';
  propertyData.propertyManager = r.propertyManager || r.property_manager || '';

  // Additional columns preserved for future mapping/extensions
  const additionalFields = {};
  for (const k of Object.keys(r)) {
    const lk = (k || '').toString().toLowerCase();
    // treat any 'address.' or 'address_' prefixed keys and contact/name/type as core
    if (lk === 'name' || lk === 'type' || lk.startsWith('address.') || lk.startsWith('address_') || ['street', 'city', 'state', 'zip', 'country', 'ownername', 'owneremail', 'ownerphone', 'contactname', 'contactemail', 'contactphone', 'contact', 'email', 'phone'].includes(lk)) {
      continue;
    }
    additionalFields[k] = r[k];
  }
  if (Object.keys(additionalFields).length > 0) propertyData.additionalFields = additionalFields;

  // Note: createPropertyService requires unitDetails and other fields; importer will
  // let createPropertyService validate and reject rows that are missing required fields.
  // Provide a minimal default unitDetails so CSVs that don't include unit info can still create a property.
  if (!Array.isArray(propertyData.unitDetails) || propertyData.unitDetails.length === 0) {
    propertyData.unitDetails = [{ unitName: 'Unit 1', unitType: 'Other', squareFeet: 0, rentIncludes: [] }];
  }
  return propertyData;
}



// Delete property service
async function deletePropertyService(propertyId, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  // Check if property is referenced in invoices, expenses, or maintenance records
  const { invoiceCount, expenseCount, maintenanceCount } = await countPropertyReferences(propertyId);

  if (invoiceCount > 0 || expenseCount > 0 || maintenanceCount > 0) {
    const references = [];
    if (invoiceCount > 0) references.push(`${invoiceCount} invoice(s)`);
    if (expenseCount > 0) references.push(`${expenseCount} expense(s)`);
    if (maintenanceCount > 0) references.push(`${maintenanceCount} maintenance record(s)`);

    const err = new Error(
      `Cannot delete property. It is referenced in ${references.join(', ')}. ` +
      `Please delete or reassign these records first, or archive the property instead.`
    );
    err.status = 400;
    throw err;
  }

  // perform delete within a transaction managed by the service unless caller provided a session
  const runDelete = async (session) => {
    const opts = {};
    if (session) opts.session = session;
    const deleted = await Property.findByIdAndDelete(propertyId, opts);
    if (!deleted) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }
    const result = deleted.toObject();
    await logActivity({
      userId: options.userId || result.landlord_id,
      action: 'DELETE',
      module: 'Property',
      entityId: result._id,
      entityName: result.name,
      description: `Deleted property "${result.name}"`,
      meta: { address: result.address }
    });
    return result;
  };

  if (options.session) {
    return runDelete(options.session);
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await runDelete(session);
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
}

// Update existing property service
async function updatePropertyService(propertyId, propertyData, landlordId, options = {}) {
  // For updates, only validate fields that are provided
  const errors = [];

  // Only validate address if it's provided
  if (propertyData.address) {
    const address = propertyData.address;
    const requiredAddressFields = ['street', 'city', 'state', 'zip', 'country'];
    requiredAddressFields.forEach((f) => {
      if (!address[f]) errors.push(`Address field '${f}' is required`);
    });
  }
  // For updates: validate unitDetails only when provided in the payload
  if (typeof propertyData.unitDetails !== 'undefined') {
    if (!Array.isArray(propertyData.unitDetails) || propertyData.unitDetails.length < 1) {
      errors.push('At least one unit is required in unitDetails');
    } else {
      propertyData.unitDetails.forEach((u, idx) => {
        if (!u || typeof u !== 'object') {
          errors.push(`unitDetails[${idx}] must be an object`);
          return;
        }
        if (!u.unitName) errors.push(`unitDetails[${idx}].unitName is required`);
        if (!u.unitType) errors.push(`unitDetails[${idx}].unitType is required`);
        if (u.rentIncludes && !Array.isArray(u.rentIncludes)) errors.push(`unitDetails[${idx}].rentIncludes must be an array`);
        // if unitType indicates residential, enforce additional residential fields
        const ut = (u.unitType || '').toString().toLowerCase();
        const isResidential = ut && ut.includes('resid');
        if (isResidential) {
          if (typeof u.bedRooms === 'undefined' || u.bedRooms === null) errors.push(`unitDetails[${idx}].bedRooms is required for residential units`);
          if (typeof u.bathRoom === 'undefined' || u.bathRoom === null) errors.push(`unitDetails[${idx}].bathRoom is required for residential units`);
          // Keep amenities optional for residential units to match landlord flow.
        }
        // squareFeet is required for all unit types
        if (typeof u.squareFeet === 'undefined' || u.squareFeet === null) errors.push(`unitDetails[${idx}].squareFeet is required`);
      });
    }
  }

  if (errors.length > 0) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }

  // core update logic extracted to allow transactional wrapper
  const doUpdate = async (session) => {
    const findOpts = {};
    if (session) findOpts.session = session;
    const prop = await Property.findOne({ _id: propertyId, landlord_id: landlordId }, null, findOpts);
    if (!prop) {
      const err = new Error('Property not found for this landlord');
      err.status = 404;
      throw err;
    }

    if (options.hoaContext?.hoaId && prop.hoaId && String(prop.hoaId) !== String(options.hoaContext.hoaId)) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }

    // ensure unique name per landlord (if name changed)
    if (prop.name !== propertyData.name) {
      const existing = await Property.findOne({ landlord_id: landlordId, name: propertyData.name });
      if (existing) {
        const err = new Error('Property name must be unique per landlord');
        err.status = 409;
        throw err;
      }
    }

    // update fields only if provided
    if (typeof propertyData.name !== 'undefined') prop.name = propertyData.name;
    // persist both new and legacy fields for compatibility
    if (propertyData.propertyType || propertyData.type) {
      prop.propertyType = propertyData.propertyType || propertyData.type;
      prop.type = propertyData.type || propertyData.propertyType;
    }
    if (typeof propertyData.description !== 'undefined') prop.description = propertyData.description;
    if (typeof propertyData.ownershipType !== 'undefined') prop.ownershipType = propertyData.ownershipType;
    if (typeof propertyData.propertyManager !== 'undefined') prop.propertyManager = propertyData.propertyManager;
    if (propertyData.address) {
      const address = propertyData.address;
      prop.address = {
        street: address.street,
        line2: address.line2,
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country,
      };
    }
    const billingTzFields = resolvePropertyBillingTimezoneFields(propertyData, prop.toObject ? prop.toObject() : prop);
    if (
      typeof propertyData.billingTimezone !== 'undefined'
      || propertyData.address
      || !prop.billingTimezone
    ) {
      prop.billingTimezone = billingTzFields.billingTimezone;
      prop.billingTimezoneSource = billingTzFields.billingTimezoneSource;
    }
    // owner fields - only update if provided
    if (typeof propertyData.ownerName !== 'undefined') prop.ownerName = propertyData.ownerName;
    if (typeof propertyData.ownerEmail !== 'undefined') prop.ownerEmail = propertyData.ownerEmail;
    if (typeof propertyData.ownerPhone !== 'undefined') prop.ownerPhone = propertyData.ownerPhone;
    if (typeof propertyData.ownerType !== 'undefined') prop.ownerType = propertyData.ownerType;
    // 'units' field removed from schema; do not set it here.
    if (typeof propertyData.amenities !== 'undefined') {
      prop.amenities = Array.isArray(propertyData.amenities) ? propertyData.amenities : [];
    }
    // unitDetails: replace only if provided in update payload
    // CRITICAL: Preserve existing _id for each unit to maintain owner/ledger references
    if (typeof propertyData.unitDetails !== 'undefined') {
      const incomingUnits = Array.isArray(propertyData.unitDetails) ? propertyData.unitDetails : [];
      const existingUnits = prop.unitDetails || [];

      // Map existing units by unitName for quick lookup
      const existingUnitsMap = {};
      for (let i = 0; i < existingUnits.length; i++) {
        const unit = existingUnits[i];
        if (unit && unit.unitName) {
          existingUnitsMap[unit.unitName.toLowerCase()] = unit;
        }
      }

      // Preserve _id for matching units, assign new for new units
      const updatedUnits = [];
      for (let i = 0; i < incomingUnits.length; i++) {
        const incomingUnit = incomingUnits[i];
        if (!incomingUnit || !incomingUnit.unitName) continue;

        const unitNameLower = incomingUnit.unitName.toLowerCase();
        const existingUnit = existingUnitsMap[unitNameLower];

        // If unit exists, preserve its _id; otherwise MongoDB will auto-generate
        if (existingUnit && existingUnit._id) {
          updatedUnits.push({ ...incomingUnit, _id: existingUnit._id });
        } else {
          updatedUnits.push(incomingUnit);
        }
      }

      prop.unitDetails = updatedUnits;
    }
    // propertySettings: replace only if provided in update payload
    if (typeof propertyData.propertySettings !== 'undefined') {
      prop.propertySettings = mergeBankAccountFields(propertyData, prop.propertySettings || {});
    }
    if (typeof propertyData.status !== 'undefined') prop.status = propertyData.status;
    prop.requestPayload = cloneForStorage(propertyData);

    const saveOpts = {};
    if (session) saveOpts.session = session;
    const saved = await prop.save(saveOpts);
    const result = saved.toObject();
    await logActivity({
      userId: options.userId || landlordId,
      action: 'UPDATE',
      module: 'Property',
      entityId: result._id,
      entityName: result.name,
      description: `Updated property "${result.name}"`,
      meta: { address: result.address }
    });
    return result;
  };

  if (options.session) return doUpdate(options.session);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await doUpdate(session);
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
}

// Create property service
async function createPropertyService(propertyData, landlordId, options = {}) {
  // Input-shape validation (required fields, address format, unitDetails structure,
  // contact format) is handled by Joi middleware attached to routes. Service focuses
  // on business rules: uniqueness, transactional persistence and DB checks.
  const address = propertyData.address || {};
  const activeHoaId = options.hoaContext?.hoaId || propertyData.hoaId || null;

  // ensure unique name per landlord
  const safeLandlordId = toObjectId(landlordId);
  if (!safeLandlordId) {
    const err = new Error('Invalid landlordId');
    err.status = 400;
    throw err;
  }
  const existingFilter = {
    landlord_id: safeLandlordId,
    name: String(propertyData.name || '').trim(),
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  };
  if (activeHoaId) {
    const safeHoaId = toObjectId(activeHoaId);
    if (safeHoaId) existingFilter.hoaId = safeHoaId;
  }
  const existing = await Property.findOne(existingFilter);
  if (existing) {
    const err = new Error('Property name must be unique per community');
    err.status = 409;
    throw err;
  }

  // core create logic extracted so service can manage transactions when needed
  const doCreate = async (session) => {
    const billingTzFields = resolvePropertyBillingTimezoneFields(propertyData);
    // construct and save
    const prop = new Property({
      landlord_id: landlordId,
      hoaId: activeHoaId || undefined,
      sourcePortal: 'hoa',
      name: propertyData.name,
      // include both new and legacy fields
      propertyType: propertyData.propertyType || propertyData.type,
      type: propertyData.type || propertyData.propertyType,
      description: propertyData.description,
      ownershipType: propertyData.ownershipType,
      propertyManager: propertyData.propertyManager,
      address: {
        street: address.street,
        line2: typeof address.line2 !== 'undefined' ? address.line2 : address.addressLine2,
        addressLine2: typeof address.addressLine2 !== 'undefined' ? address.addressLine2 : address.line2,
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country,
      },
      billingTimezone: billingTzFields.billingTimezone,
      billingTimezoneSource: billingTzFields.billingTimezoneSource,
      amenities: Array.isArray(propertyData.amenities) ? propertyData.amenities : [],
      unitDetails: Array.isArray(propertyData.unitDetails) ? propertyData.unitDetails : [],
      propertySettings: mergeBankAccountFields(propertyData, {}),
      ownerName: propertyData.ownerName,
      ownerEmail: propertyData.ownerEmail,
      ownerPhone: propertyData.ownerPhone,
      ownerType: propertyData.ownerType || propertyData.ownershipType,
      status: propertyData.status || PROPERTY_STATUS.VACANT,
      associatedOwnerIds: Array.isArray(propertyData.associatedOwnerIds) ? propertyData.associatedOwnerIds : [],
      requestPayload: cloneForStorage(propertyData),
    });
    if (session) {
      const docs = await Property.create([prop], { session });
      const result = docs[0].toObject();
      await logActivity({
        userId: options.userId || landlordId,
        action: 'CREATE',
        module: 'Property',
        entityId: result._id,
        entityName: result.name,
        description: `Created property "${result.name}"`,
        meta: { address: result.address }
      });

      // Update owners' mailing addresses if they don't have one
      if (result.associatedOwnerIds && result.associatedOwnerIds.length > 0) {
        await updateOwnersMailingAddress(result.associatedOwnerIds, result.address, session);
      }

      return result;
    }

    const saved = await prop.save();
    const result = saved.toObject();
    await logActivity({
      userId: options.userId || landlordId,
      action: 'CREATE',
      module: 'Property',
      entityId: result._id,
      entityName: result.name,
      description: `Created property "${result.name}"`,
      meta: { address: result.address }
    });

    // Update owners' mailing addresses if they don't have one
    if (result.associatedOwnerIds && result.associatedOwnerIds.length > 0) {
      await updateOwnersMailingAddress(result.associatedOwnerIds, result.address);
    }

    return result;
  };

  if (options.session) return doCreate(options.session);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await doCreate(session);
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
}
/**
 * Compute live stats for a single property detail view.
 *
 * Runs two independent DB queries (overdue invoices + maintenance counts).
 * Used only by getPropertyByIdService when include=stats - not for list views.
 * List/batch callers should use bulkFetchHoaPropertyListData instead; do not cache
 * or batch-call this helper across many properties.
 */
async function computeStatsForProperty(property) {
  const today = DateUtil.startOfDayEST(ClockService.now());

  const [amountOverdue, { openMaintenance, closedMaintenance }] = await Promise.all([
    findOverdueInvoicesByProperty(property._id, today)
      .then((invoices) => invoices.reduce((sum, invoice) => sum + Number(invoice.balanceDue || 0), 0))
      .catch(() => 0),
    aggregateMaintenanceCountsByProperty(property._id).catch(() => ({ openMaintenance: 0, closedMaintenance: 0 })),
  ]);

  const hasOwners = Array.isArray(property.associatedOwnerIds) && property.associatedOwnerIds.length > 0;
  const monthlyFee = Number(property.monthlyRecurringFee || 0);

  return {
    amountOverdue,
    billingCycleStatus: hasOwners ? 'Active' : '-',
    totalFees: monthlyFee,
    openMaintenance,
    closedMaintenance,
  };
}

/**
 * HOA unit detail: fee invoice totals (not lease/rent-centric).
 */
async function getFeesCollectionSummaryForProperty(propertyId, monthlyRecurringFee) {
  try {
    const rows = await findFeeInvoicesForProperty(propertyId);

    const today = DateUtil.startOfDayEST(ClockService.now());
    let totalBilled = 0;
    let collected = 0;
    let outstanding = 0;
    let upcomingDues = 0;

    for (const inv of rows) {
      totalBilled += Number(inv.subAmount || 0);
      const status = String(inv.status || '');
      // Collected is Paid / Partially Paid cash only — exclude Waived invoices.
      if (status !== 'Waived') {
        collected += Number(inv.alreadyPaid || 0);
      }
      const bal = Number(inv.balanceDue || 0);
      if (bal <= 0) continue;
      if (status === 'Paid' || status === 'Waived') continue;
      const dueRaw = inv.dueDate ? DateUtil.toUTC(inv.dueDate) : null;
      const due = dueRaw ? DateUtil.startOfDayEST(dueRaw) : null;
      if (due && due < today) outstanding += bal;
      else if (due && due >= today) upcomingDues += bal;
      else outstanding += bal;
    }

    return {
      period: formatMonthYearInAppTimezone(ClockService.now()),
      monthlyRecurringFee: Number(monthlyRecurringFee || 0),
      totalBilled,
      collected,
      outstanding,
      upcomingDues,
    };
  } catch (e) {
    return {
      period: formatMonthYearInAppTimezone(ClockService.now()),
      monthlyRecurringFee: Number(monthlyRecurringFee || 0),
      totalBilled: 0,
      collected: 0,
      outstanding: 0,
      upcomingDues: 0,
    };
  }
}

const PROPERTY_DETAIL_SECTIONS = ['core', 'stats', 'owners', 'invoices', 'maintenance', 'fees'];

/**
 * Align property detail billing fields with GET /hoa/owners/units/:id (mapUnitResponse).
 * Without this, Account Summary can show "-" for Billing Effective Date while Edit Property
 * still shows Balance as of Date when balanceAsOf was cleared but billing is otherwise active.
 */
function normalizeUnitBillingFieldsForResponse(unit = {}) {
  const hasBillingSetup = Boolean(
    unit.balanceAsOf ||
    (unit.startingBalance || 0) !== 0 ||
    (unit.monthlyRecurringFee || 0) > 0
  );

  if (!hasBillingSetup) {
    return {
      startingBalance: null,
      balanceAsOf: null,
      monthlyRecurringFee: null,
      paymentTerm: 0,
    };
  }

  return {
    startingBalance: unit.startingBalance || 0,
    balanceAsOf: unit.balanceAsOf || unit.createdAt || null,
    monthlyRecurringFee: unit.monthlyRecurringFee || 0,
    paymentTerm: unit.paymentTerm || 12,
  };
}

/**
 * parse Property Detail Include
 *
 * Performs logic operations for parsePropertyDetailInclude.
 *
 * @param includeParam - Request/input argument
 * @returns Operations result
 */
function parsePropertyDetailInclude(includeParam) {
  if (includeParam == null || includeParam === '' || includeParam === 'all') {
    return new Set(PROPERTY_DETAIL_SECTIONS);
  }
  const parts = String(includeParam)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const selected = parts.filter((p) => PROPERTY_DETAIL_SECTIONS.includes(p));
  return selected.length > 0 ? new Set(selected) : new Set(PROPERTY_DETAIL_SECTIONS);
}

// Get property by id with computed stats and normalized fields
async function getPropertyByIdService(id, options = {}) {
  if (!id) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }

  const include = parsePropertyDetailInclude(options.include);

  const prop = await Property.findById(id).populate('images.metadataId').lean();
  if (!prop) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }

  if (options.hoaContext?.hoaId && prop.hoaId && String(prop.hoaId) !== String(options.hoaContext.hoaId)) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }

  if (prop.notes?.length) {
    prop.notes = await enrichNotesWithAuthors(prop.notes);
    prop.notes = await enrichNotesAttachments(prop.notes);
  }

  const documentsService = require('../../../../../shared/modules/documents/service/documents.service');
  const imageUrls = [];
  for (const img of (prop.images || [])) {
    if (!img) continue;
    const meta = img.metadataId && typeof img.metadataId === 'object' ? img.metadataId : null;
    const metadataId = meta?._id || img.metadataId;
    if (!metadataId) continue;
    try {
      let url = null;
      try {
        url = await documentsService.getPresignedUrl(String(metadataId), 3600);
      } catch (e) {
        url = meta ? documentsService.buildPublicUrl(meta) : null;
      }
      if (url) imageUrls.push(url);
    } catch (e) {
      logger.warn(`Failed to resolve HOA property image ${metadataId}:`, e.message);
    }
  }
  prop.images = imageUrls;

  const sectionTasks = {};
  if (include.has('stats')) {
    sectionTasks.stats = computeStatsForProperty(prop);
  }
  if (include.has('owners')) {
    sectionTasks.owners = getAssociatedOwnersForProperty(prop._id);
  }
  if (include.has('invoices')) {
    sectionTasks.invoices = getInvoicesForProperty(prop._id);
  }
  if (include.has('maintenance')) {
    sectionTasks.maintenance = getOpenMaintenanceRequests(prop._id);
  }
  if (include.has('fees')) {
    sectionTasks.fees = getFeesCollectionSummaryForProperty(prop._id, prop.monthlyRecurringFee);
  }

  const sectionKeys = Object.keys(sectionTasks);
  const sectionResults = sectionKeys.length > 0
    ? await Promise.all(sectionKeys.map((key) => sectionTasks[key]))
    : [];
  const resolved = Object.fromEntries(sectionKeys.map((key, index) => [key, sectionResults[index]]));

  const stats = resolved.stats || {};
  const owners = resolved.owners || [];
  const invoiceData = resolved.invoices || { upcomingInvoices: [], pastOverdueInvoices: [] };
  const openMaintenanceRequests = resolved.maintenance || [];
  const feesCollection = resolved.fees || null;

  const maintenanceRequests = include.has('maintenance')
    ? openMaintenanceRequests.map((req) => ({
      id: req.id,
      issue: req.title || req.description,
      date: req.requestDate ? formatDateInAppTimezone(req.requestDate)
        : formatDateInAppTimezone(req.createdAt),
      status: req.status === 'Open' || req.status === 'Submitted' || req.status === 'InProgress' ? 'Open' : req.status,
      category: req.category || 'General',
    }))
    : undefined;

  const invoices = include.has('invoices')
    ? {
      upcoming: invoiceData.upcomingInvoices.map((inv) => ({
        id: inv.id,
        dueDate: formatDateInAppTimezone(inv.dueDate),
        amount: inv.balanceDue || inv.subAmount || 0,
        tenant: inv.tenant || 'N/A',
        unit: inv.unit || 'N/A',
      })),
      pastDue: invoiceData.pastOverdueInvoices.map((inv) => ({
        id: inv.id,
        dueDate: formatDateInAppTimezone(inv.dueDate),
        amount: inv.balanceDue || inv.subAmount || 0,
        overdue: true,
        tenant: inv.tenant || 'N/A',
        unit: inv.unit || 'N/A',
      })),
    }
    : undefined;

  const emergencyContact = prop.emergencyContact || null;

  // Use resolved cloud URLs from prop.images (already mapped above). Never substitute stock photos.
  const images = Array.isArray(prop.images) ? prop.images : [];

  const response = {
    ...prop,
    emergencyContact,
    images,
    lastUpdated: prop.updatedAt
      ? formatDateInAppTimezone(prop.updatedAt, { day: 'numeric' })
      : '',
    billingProcessingStatus:
      prop.requestPayload &&
      typeof prop.requestPayload === 'object' &&
      !Array.isArray(prop.requestPayload)
        ? prop.requestPayload.billingProcessingStatus ?? null
        : null,
    billingProcessingError:
      prop.requestPayload &&
      typeof prop.requestPayload === 'object' &&
      !Array.isArray(prop.requestPayload)
        ? prop.requestPayload.billingProcessingError ?? null
        : null,
  };

  if (include.has('stats')) {
    Object.assign(response, {
      amountOverdue: stats.amountOverdue,
      billingCycleStatus: stats.billingCycleStatus,
      totalFees: stats.totalFees,
      openMaintenance: stats.openMaintenance,
      closedMaintenance: stats.closedMaintenance,
    });
  }
  if (include.has('owners')) {
    response.owners = owners || [];
  }
  if (include.has('maintenance')) {
    response.maintenanceRequests = maintenanceRequests;
  }
  if (include.has('invoices')) {
    response.invoices = invoices;
  }
  if (include.has('fees')) {
    response.feesCollection = feesCollection;
  }

  try {
    const { getInvoiceScheduleMetaForUnit } = require('../../owners/services/invoiceScheduleMeta.service');
    response.invoiceScheduleMeta = await getInvoiceScheduleMetaForUnit(id, { unit: prop });
  } catch (metaErr) {
    logger.warn('[property] invoiceScheduleMeta failed:', metaErr?.message || metaErr);
    response.invoiceScheduleMeta = null;
  }

  try {
    const ledgerService = require('../../owners/services/ledger.service');
    const summary = await ledgerService.getBalanceSummary(id, {
      readOnly: true,
      skipCollectionStats: true,
      omitEntries: true,
    });
    const display = ledgerService.portfolioDisplayBalanceFromSummary(summary);
    response.remainingCredit = Number(summary.remainingCredit || 0);
    response.creditBalance = Number(display.creditBalance || 0);
    response.netBalance = Number(display.netBalance || 0);
    response.pastDueAmount = Number(display.pastDueAmount || response.pastDueAmount || 0);
    response.dueTodayAmount = Number(display.dueTodayAmount || response.dueTodayAmount || 0);
  } catch (balanceErr) {
    logger.warn('[property] balance summary enrichment failed:', balanceErr?.message || balanceErr);
  }

  Object.assign(response, normalizeUnitBillingFieldsForResponse(prop));

  return response;
}

// Append uploaded images metadata to a property and return the updated images array
async function addImagesToPropertyService(propertyId, imagesArray, options = {}) {
  if (!propertyId) {
    const err = new Error('propertyId is required');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(imagesArray) || imagesArray.length === 0) {
    const err = new Error('imagesArray must be a non-empty array');
    err.status = 400;
    throw err;
  }
  // persist images; allow caller to provide session or let service manage a transaction
  const doPersist = async (session) => {
    if (session) {
      // imagesArray expected to contain { metadataId }
      const pushed = await Property.findByIdAndUpdate(propertyId, { $push: { images: { $each: imagesArray.map(img => ({ metadataId: img.metadataId })) } } }, { new: true, session });
      if (!pushed) {
        const err = new Error('Property not found');
        err.status = 404;
        throw err;
      }
      return pushed.images || [];
    }

    const prop = await Property.findById(propertyId);
    if (!prop) {
      const err = new Error('Property not found');
      err.status = 404;
      throw err;
    }

    // push each image metadataId into property.images
    imagesArray.forEach(img => {
      prop.images = prop.images || [];
      prop.images.push({ metadataId: img.metadataId });
    });

    const saved = await prop.save();
    return saved.images || [];
  };

  if (options.session) return doPersist(options.session);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await doPersist(session);
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
}

// Upload files to S3 and persist metadata into Property.images transactionally.
// files: array of multer file objects { path, filename, originalname }
async function uploadPropertyImagesService(propertyId, files = [], options = {}) {
  if (!propertyId) throw Object.assign(new Error('propertyId is required'), { status: 400 });
  if (!Array.isArray(files) || files.length === 0) throw Object.assign(new Error('files is required and must be a non-empty array'), { status: 400 });

  const s3Client = require('../../../../../integrations/s3');
  const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
  const config = require('../../../../../config/default');
  const uploaded = [];

  try {
    for (const f of files) {
      const filename = f.filename || f.originalname;
      const key = s3Client.getKeyForProperty ? s3Client.getKeyForProperty(propertyId, filename) : `${UPLOAD_PROPERTY_SUBDIR || 'properties'}/${filename}`;
      const result = await s3Client.upload({ localFilePath: f.path, key });

      // Read bucket/region from config/env
      const bucketName = config.s3 && config.s3.bucketName ? config.s3.bucketName : (process.env.S3_BUCKET || 'mock-bucket');
      const region = config.s3 && config.s3.region ? config.s3.region : (process.env.AWS_REGION || 'mock-region');
      const contentType = f.mimetype || 'application/octet-stream';
      const size = f.size || 0;

      // Insert metadata into MongoDB
      const metadataDoc = await DocumentMetadata.create({
        key: result.Key || key,
        bucketName,
        region,
        size,
        contentType,
        originalName: filename
      });

      uploaded.push({
        key: result.Key || key,
        url: result.Location || (s3Client.baseUrl ? `${s3Client.baseUrl}/${key}` : `/${key}`),
        metadataId: metadataDoc._id
      });
    }

    // persist uploaded metadata in DB transactionally
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      // Pass metadataId in images array for reference
      const savedImages = await addImagesToPropertyService(propertyId, uploaded, { session });
      await session.commitTransaction();
      session.endSession();
      return savedImages;
    } catch (dbErr) {
      await session.abortTransaction();
      session.endSession();
      // attempt to cleanup uploaded objects (use metadataId to resolve key)
      const DocumentMetadata = require('../../../../../shared/modules/documents/model/documentMetadata.model');
      for (const u of uploaded) {
        try {
          if (u.metadataId) {
            const meta = await DocumentMetadata.findById(u.metadataId).lean();
            if (meta && meta.key) await s3Client.delete({ key: meta.key });
          }
        } catch (ignore) { /* ignore */ }
      }
      throw dbErr;
    }
  } catch (e) {
    // cleanup local temp files if any
    if (files && files.length) {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmpDir = fs.realpathSync(os.tmpdir());
      for (const f of files) {
        try {
          if (f.path && typeof f.path === 'string') {
            const resolved = path.resolve(f.path);
            if (resolved.startsWith(tmpDir + path.sep) || resolved.startsWith(tmpDir)) {
              fs.unlinkSync(resolved);
            }
          }
        } catch (ignore) { /* ignore */ }
      }
    }
    throw e;
  }
}

// Export properties as CSV using the same filters/pagination as getPropertiesService
async function exportPropertiesCsvService(filters = {}, userContext = null) {
  // Delegate to getPropertiesService so we apply the same filtering, sorting and pagination
  const result = await getPropertiesService(filters, userContext);
  const data = (result && result.data) || [];

  // If no data, return an informative CSV
  if (!data || data.length === 0) {
    const filename = `properties_export_${Date.now()}.csv`;
    return { filename, csv: 'No properties found' };
  }

  // Use a stable header order that matches the GET /properties response fields
  const headers = ['name', 'address', 'totalFees', 'amountOverdue', 'billingCycleStatus', 'status', 'openMaintenance', 'closedMaintenance', 'owners'];

  // CSV escape helper
  function csvEscape(val) {
    if (val === null || typeof val === 'undefined') return '""';
    if (typeof val === 'object') {
      try { val = JSON.stringify(val); } catch { val = String(val); }
    }
    let s = String(val);
    if (/^[+\-=@]/.test(s.charAt(0))) s = "'" + s; // prevent Excel eval
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const rows = [headers.join(',')];
  for (const rowObj of data) {
    const ownerNames = Array.isArray(rowObj.owners)
      ? rowObj.owners.map((o) => formatOwnerDisplayName(o)).join('; ')
      : '';
    const mapped = Object.assign({}, rowObj, {
      billingCycleStatus: rowObj.billingCycleStatus || '-',
      totalFees: rowObj.totalFees ?? rowObj.totalRent ?? 0,
      name: rowObj.name || rowObj.unitName || rowObj.propertyName || '',
      owners: ownerNames,
    });
    const row = headers.map(h => csvEscape(mapped[h]));
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const landlordId = filters && filters.landlordId ? String(filters.landlordId) : 'all';
  const ts = DateUtil.buildExportFilenameTimestamp();
  const filename = `properties_${landlordId}_${ts}.csv`;

  return { filename, csv };
}

/**
 * Check if a property has any active listings
 */
async function checkPropertyHasListing(propertyId) {
  try {
    const listing = await findActiveListingByProperty(propertyId);
    return !!listing;
  } catch (error) {
    logger.warn('Error checking property listing:', error.message);
    return false;
  }
}

/**
 * Check if a specific unit has any active listings
 */
async function checkUnitHasListing(propertyId, unitName) {
  try {
    const listing = await findActiveListingByProperty(propertyId, unitName);
    return !!listing;
  } catch (error) {
    logger.warn('Error checking unit listing:', error.message);
    return false;
  }
}

async function getPortfolioOverviewService(landlordId) {
  const t0 = Date.now();
  if (!landlordId) {
    const err = new Error('landlordId is required');
    err.status = 400;
    throw err;
  }

  try {
    const safeLandlordId = toObjectId(landlordId);
    if (!safeLandlordId) {
      const err = new Error('Invalid landlordId');
      err.status = 400;
      throw err;
    }
    const properties = await Property.find({ landlord_id: safeLandlordId }, {
      _id: 1,
      unitDetails: 1,
      associatedOwnerIds: 1,
    }).lean();

    if (!properties || properties.length === 0) {
      return {
        totalUnits: 0,
        occupancyPercentage: 0,
        occupiedUnits: 0,
        vacantUnits: 0,
        rentPaymentPercentage: 0,
        onTimeUnits: 0,
        behindUnits: 0,
      };
    }

    const propertyIds = properties.map((p) => toObjectId(p._id));
    const today = DateUtil.startOfDayEST(ClockService.now());
    const unpaidSummary = await aggregateUnpaidSummaryByPropertyIds(propertyIds, today);
    const { overdueByProperty } = buildUnpaidSummaryMaps(unpaidSummary);

    let totalUnits = 0;
    let occupiedUnits = 0;
    let onTimeUnits = 0;
    let behindUnits = 0;

    for (const property of properties) {
      const propId = property._id.toString();
      const unitDetails = property.unitDetails || [];
      const hasOwners = Array.isArray(property.associatedOwnerIds) && property.associatedOwnerIds.length > 0;
      const unitCount = unitDetails.length > 0 ? unitDetails.length : 1;
      const hasOverdue = (overdueByProperty[propId] || 0) > 0;

      totalUnits += unitCount;
      if (hasOwners) {
        occupiedUnits += unitCount;
        if (hasOverdue) behindUnits += unitCount;
        else onTimeUnits += unitCount;
      }
    }

    const vacantUnits = totalUnits - occupiedUnits;
    const occupancyPercentage = totalUnits > 0 ? Math.round((occupiedUnits / totalUnits) * 100) : 0;
    const rentPaymentPercentage = occupiedUnits > 0 ? Math.round((onTimeUnits / occupiedUnits) * 100) : 0;

    logger.info(`[PERF] Portfolio overview: ${Date.now() - t0}ms`);

    return {
      totalUnits,
      occupancyPercentage,
      occupiedUnits,
      vacantUnits,
      rentPaymentPercentage,
      onTimeUnits,
      behindUnits,
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get upcoming and past/overdue invoices for a property
 */
async function getInvoicesForProperty(propertyId) {
  try {
    const invoices = await findInvoicesForPropertyDetail(propertyId);

    if (!invoices || invoices.length === 0) {
      return { upcomingInvoices: [], pastOverdueInvoices: [] };
    }

    const ownerIds = new Set();
    const tenantIds = new Set();
    for (const invoice of invoices) {
      for (const ownerId of invoice.owners || invoice.ownerIds || []) {
        if (ownerId) ownerIds.add(String(ownerId));
      }
      for (const tenantId of invoice.tenants || []) {
        if (tenantId) tenantIds.add(String(tenantId));
      }
    }

    const fallbackOwners = ownerIds.size === 0 && tenantIds.size === 0
      ? await getAssociatedOwnersForProperty(propertyId)
      : [];

    const userIds = [...new Set([...ownerIds, ...tenantIds])];
    const usersById = userIds.length > 0
      ? await User.findActiveByIds(userIds, { select: { firstName: 1, lastName: 1 } })
      : [];

    const userMap = new Map(usersById.map((u) => [String(u._id), u]));

    const formatOwnerName = (ids = []) =>
      ids
        .map((id) => {
          const u = userMap.get(String(id));
          return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
        })
        .filter(Boolean)
        .join(', ');

    const fallbackOwnerName = fallbackOwners.map((o) => o.name).filter(Boolean).join(', ');

    const upcomingInvoices = [];
    const pastOverdueInvoices = [];

    for (const invoice of invoices) {
      const dueCmp = invoice.dueDate ? compareCalendarDateToToday(invoice.dueDate) : null;
      const isOverdue = invoice.status === 'Overdue';
      const isPastDue = dueCmp !== null && dueCmp < 0;
      const isPaid = invoice.status === 'Paid';

      const unitName = invoice.unit || invoice.propertyName || null;
      const ownerIdsForInvoice = [...(invoice.owners || []), ...(invoice.ownerIds || []), ...(invoice.tenants || [])];
      const ownerName = formatOwnerName(ownerIdsForInvoice) || fallbackOwnerName || null;

      const formattedInvoice = {
        id: invoice._id,
        type: invoice.type,
        status: invoice.status,
        unit: unitName,
        tenant: ownerName,
        owner: ownerName,
        term: invoice.term,
        subAmount: invoice.subAmount || 0,
        alreadyPaid: invoice.alreadyPaid || 0,
        balanceDue: invoice.balanceDue || 0,
        dueDate: invoice.dueDate,
        paidOn: invoice.paidOn,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
      };

      if (isOverdue || (isPastDue && !isPaid)) {
        pastOverdueInvoices.push(formattedInvoice);
      } else if (dueCmp !== null && dueCmp >= 0 && !isPaid) {
        upcomingInvoices.push(formattedInvoice);
      }
    }

    return {
      upcomingInvoices: upcomingInvoices
        .sort((a, b) => (DateUtil.toEpoch(a.dueDate) || 0) - (DateUtil.toEpoch(b.dueDate) || 0))
        .slice(0, 3),
      pastOverdueInvoices: pastOverdueInvoices
        .sort((a, b) => (DateUtil.toEpoch(b.dueDate) || 0) - (DateUtil.toEpoch(a.dueDate) || 0))
        .slice(0, 3),
    };
  } catch (e) {
    logger.error('Error fetching invoices for property:', e);
    return { upcomingInvoices: [], pastOverdueInvoices: [] };
  }
}

/**
 * Get latest 3 open maintenance requests for a property
 */
async function getOpenMaintenanceRequests(propertyId) {
  try {
    const requests = await findOpenMaintenanceByProperty(propertyId, 3);

    if (!requests || requests.length === 0) {
      return [];
    }

    const property = await Property.findById(propertyId).select('unitDetails').lean();

    // Format maintenance requests
    return requests.map(request => ({
      id: request._id,
      title: request.title,
      description: request.description,
      category: request.category,
      status: request.status,
      isUrgent: request.isUrgent,
      unitId: request.unitId,
      units: unitDisplayNameFromMaintenance(property, request),
      requestDate: request.request_date,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      requestedBy: request.requestedBy,
      assignedTo: request.assignedTo
    }));
  } catch (e) {
    logger.error('Error fetching maintenance requests for property:', e);
    return [];
  }
}


module.exports = {
  getPropertiesService,
  getPropertyByIdService,
  parsePropertyDetailInclude,
  normalizeUnitBillingFieldsForResponse,
  PROPERTY_DETAIL_SECTIONS,
  createPropertyService,
  updatePropertyService,
  deletePropertyService,
  archivePropertyService,
  unarchivePropertyService,
  addImagesToPropertyService,
  uploadPropertyImagesService,
  exportPropertiesCsvService,
  addNoteToPropertyService,
  updateNoteInPropertyService,
  deleteNoteFromPropertyService,
  importPropertiesFromCsv,
  getTenantsForProperty,
  getTenantsForUnit,
  getAssociatedOwnersForProperty,
  getPortfolioOverviewService,
  checkPropertyHasListing,
  checkUnitHasListing,
  getInvoicesForProperty,
  getOpenMaintenanceRequests,
};
