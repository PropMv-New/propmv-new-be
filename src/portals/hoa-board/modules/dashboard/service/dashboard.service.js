/**
 * ------------------------------------------------------------------
 * File: dashboard.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * dashboard.controller
 * ------------------------------------------------------------------
 */

const Property = require('../../property/model/property.model');
const Income = require('../../invoice/model/invoice.model');
const MaintenanceRequest = require('../../../../../shared/modules/maintenance/model/maintenanceRequest.model');
const Application = require('../../../../../portals/landlord/modules/application/models/application.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const mongoose = require('mongoose');
const activityService = require('./activity.service');
const invoiceService = require('../../invoice/service/invoice.service');
const logger = require('../../../../../common/logger');

const { MAINTENANCE_STATUS, MAINTENANCE_REQUEST_STATUS } = require('../../../../../common/constants/property');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { LATEST_MAINTENANCE_REQUESTS, LATEST_APPLICATIONS } = require('../../../../../common/constants/dashboard');
const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
const { resolveHoaPropertyIds, getCachedHoaPropertyIds } = require('../../../../../common/helpers/hoaPropertyScope');
const { markPerfStart } = require('../../../../../common/helpers/perfTimings');
const { unitDisplayNameFromMaintenance } = require('../../../../../common/helpers/propertyUnitReference');
const { formatDateInAppTimezone, resolveDateRangePreset, getDateKeyInTimeZone, parseAppYmd, parseDateOnlyToNoonUtc, HOA_MONGO_TIMEZONE_FOR_DATE_EXPR } = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../../common/date');

/**
 * Sanitize a single value to a mongoose ObjectId.
 * Returns null for anything that is not a valid 24-char hex ObjectId,
 * preventing NoSQL injection via operator objects (e.g. { $gt: "" }).
 */
function toObjectId(value) {
  const str = String(
    value && typeof value === 'object' && value._id ? value._id : value ?? ''
  ).trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * Sanitize an array of values to valid ObjectId instances, dropping invalid entries.
 */
function toObjectIdArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(toObjectId).filter(Boolean);
}

// Note: request-level validation (presence and date formats/order) is handled by Joi
// in the route middleware. Service will assume inputs are present and valid ISO dates.

/**
 * Fetch properties for a landlord and return the property ids and total units count.
 */
async function fetchPropertiesAndUnitCount(landlordId, hoaContext = null) {
  const hoaMatch = buildHoaBoardPropertyMatch(hoaContext);
  const activeOnly = { isDeleted: { $ne: true } };
  const projection = '_id unitDetails';
  let properties;
  if (hoaMatch) {
    const cachedIds = getCachedHoaPropertyIds(hoaContext);
    if (cachedIds !== undefined) {
      properties = cachedIds.length
        ? await Property.find({ _id: { $in: toObjectIdArray(cachedIds) }, isDeleted: { $ne: true } }).select(projection).lean()
        : [];
    } else {
      const safeHoaMatch = { ...hoaMatch };
      if (safeHoaMatch._id && safeHoaMatch._id.$in) {
        safeHoaMatch._id = { $in: toObjectIdArray(safeHoaMatch._id.$in) };
      }
      if (safeHoaMatch.hoaId) safeHoaMatch.hoaId = toObjectId(safeHoaMatch.hoaId) ?? safeHoaMatch.hoaId;
      properties = await Property.find({ ...safeHoaMatch, ...activeOnly }).select(projection).lean();
    }
  } else if (landlordId) {
    const safeId = toObjectId(landlordId);
    if (!safeId) return { properties: [], propertyIds: [], totalUnits: 0 };
    properties = await Property.find({ landlord_id: safeId, ...activeOnly }).select(projection).lean();
  } else {
    properties = [];
  }
  const propertyIds = properties.map(p => p._id);
  const totalUnits = properties.reduce((sum, p) => sum + ((p.unitDetails && p.unitDetails.length) || 0), 0);
  return { properties, propertyIds, totalUnits };
}

/**
 * Count occupied HOA units by associated owners on each property.
 */
async function calculateOccupancy(propertyIds) {
  if (!propertyIds || propertyIds.length === 0) return { occupiedUnits: 0 };

  const properties = await Property.find(
    { _id: { $in: toObjectIdArray(propertyIds) }, associatedOwnerIds: { $exists: true, $not: { $size: 0 } } },
    { unitDetails: 1 }
  ).lean();

  let occupiedUnits = 0;
  for (const property of properties) {
    const unitCount = (property.unitDetails && property.unitDetails.length) || 1;
    occupiedUnits += unitCount;
  }
  return { occupiedUnits };
}

/**
 * Bucket maintenance status aggregation rows for HOA dashboard cards.
 * Vendor-assigned tickets move to InProgress; vendor completion uses Completed.
 */
function summarizeDashboardMaintenanceStatusRows(stats = []) {
  const maintenanceStats = { open: 0, pending: 0, resolved: 0, total: 0 };
  const closedStatuses = new Set([
    MAINTENANCE_REQUEST_STATUS.RESOLVED,
    MAINTENANCE_REQUEST_STATUS.COMPLETED,
    'Completed',
  ]);
  const openStatuses = new Set([
    MAINTENANCE_REQUEST_STATUS.OPEN,
    MAINTENANCE_REQUEST_STATUS.IN_PROGRESS,
  ]);

  stats.forEach((s) => {
    const status = String(s?._id || '');
    const count = Number(s?.count) || 0;
    if (openStatuses.has(status)) {
      maintenanceStats.open += count;
    } else if (closedStatuses.has(status)) {
      maintenanceStats.resolved += count;
    } else {
      // Legacy/other statuses (e.g. Rejected) stay in pending for totals only
      maintenanceStats.pending += count;
    }
    maintenanceStats.total += count;
  });

  return maintenanceStats;
}

/**
 * Fetch open maintenance requests for Android app compatibility.
 */
async function fetchOpenMaintenance(propertyIds, limit = 0, hoaContext = null) {
  let match = null;
  if (hoaContext?.hoaId) {
    const {
      resolveHoaBoardMaintenanceScopeOr,
      buildMaintenanceQueryFromScopeOr,
    } = require('../../../../../shared/modules/maintenance/service/maintenance.service');
    const scopeOr = await resolveHoaBoardMaintenanceScopeOr(hoaContext);
    const rawMatch = buildMaintenanceQueryFromScopeOr(scopeOr);
    if (rawMatch) {
      match = { ...rawMatch };
      if (match.property_id && match.property_id.$in) {
        match.property_id = { $in: toObjectIdArray(match.property_id.$in) };
      }
      // Active work = unassigned Open + vendor-assigned InProgress
      match.status = {
        $in: [MAINTENANCE_REQUEST_STATUS.OPEN, MAINTENANCE_REQUEST_STATUS.IN_PROGRESS],
      };
    }
  } else if (propertyIds && propertyIds.length > 0) {
    match = {
      property_id: { $in: toObjectIdArray(propertyIds) },
      status: {
        $in: [MAINTENANCE_REQUEST_STATUS.OPEN, MAINTENANCE_REQUEST_STATUS.IN_PROGRESS],
      },
      isDeleted: { $ne: true },
    };
  }
  if (!match) return [];

  let query = MaintenanceRequest.find(match)
    .sort({ createdAt: -1 })
    .populate('property_id', 'name unitDetails')
    .populate('requestedBy', 'firstName lastName email phone')
    .populate('assignedTo', 'firstName lastName email phone')
    .select('_id property_id unitId units title description category status priority request_date requestedBy assignedTo estimatedCost isUrgent primaryRequestType subRequestType createdAt');

  if (limit && Number(limit) > 0) query = query.limit(Number(limit));

  const requests = await query.lean();

  return requests.map(req => {
    const rb = req.requestedBy;
    let tenantId = null;
    let tenantName = 'Unknown';
    if (Array.isArray(rb) && rb.length > 0) {
      const u0 = rb[0];
      tenantId = u0?._id || u0 || null;
      tenantName = rb.map(u => `${u.firstName || ''} ${u.lastName || ''}`.trim()).filter(Boolean).join(', ') || 'Unknown';
    } else if (rb && !Array.isArray(rb)) {
      tenantId = rb._id || rb;
      tenantName = `${rb.firstName || ''} ${rb.lastName || ''}`.trim() || 'Unknown';
    }
    return {
    id: req._id,
    propertyId: req.property_id?._id || req.property_id,
    propertyName: req.property_id?.name || 'Unknown Property',
    unitId: req.unitId ? String(req.unitId) : null,
    unitName: unitDisplayNameFromMaintenance(
      typeof req.property_id === 'object' ? req.property_id : null,
      req
    ) || null,
    tenantId,
    tenantName,
    requestType: req.category,
    primaryRequestType: req.primaryRequestType,
    subRequestType: req.subRequestType,
    priority: req.priority,
    status: req.status,
    description: req.description,
    dateCreated: req.createdAt || req.request_date,
    timestamp: req.createdAt || req.request_date,
    time: formatTimeAgo(req.createdAt || req.request_date),
    estimatedCost: req.estimatedCost || 0,
    assignedTo: req.assignedTo ? `${req.assignedTo.firstName || ''} ${req.assignedTo.lastName || ''}`.trim() : null,
    images: []
    };
  });
}

/**
 * Fetch maintenance statistics for the given properties or HOA community.
 * When startDate/endDate are provided, counts and trend are scoped to that period.
 * Pass includeTrend: false for count-only lookups (e.g. prior-period cards).
 */
async function fetchMaintenanceStats(propertyIds, hoaContext = null, range = null) {
  const includeTrend = range?.includeTrend !== false;
  const emptyStats = {
    open: 0,
    pending: 0,
    resolved: 0,
    total: 0,
    monthlyTrend: [],
    avgPerMonth: includeTrend ? 0 : '0.0',
  };

  let match = null;
  if (hoaContext?.hoaId) {
    const {
      resolveHoaBoardMaintenanceScopeOr,
      buildMaintenanceQueryFromScopeOr,
    } = require('../../../../../shared/modules/maintenance/service/maintenance.service');
    const scopeOr = await resolveHoaBoardMaintenanceScopeOr(hoaContext);
    const rawMatch = buildMaintenanceQueryFromScopeOr(scopeOr);
    if (rawMatch) {
      match = { isDeleted: { $ne: true } };
      if (rawMatch.property_id && rawMatch.property_id.$in) {
        match.property_id = { $in: toObjectIdArray(rawMatch.property_id.$in) };
      }
      if (rawMatch.hoaId) {
        const safeHoaId = toObjectId(rawMatch.hoaId);
        if (safeHoaId) match.hoaId = safeHoaId;
      }
      if (Array.isArray(rawMatch.$or)) {
        match.$or = rawMatch.$or.map((clause) => {
          const safe = {};
          if (clause.property_id && clause.property_id.$in) {
            safe.property_id = { $in: toObjectIdArray(clause.property_id.$in) };
          }
          if (clause.hoaId) safe.hoaId = toObjectId(clause.hoaId);
          return safe;
        }).filter((c) => Object.keys(c).length > 0);
        if (match.$or.length === 0) delete match.$or;
      }
    }
  } else if (propertyIds && propertyIds.length > 0) {
    match = { property_id: { $in: toObjectIdArray(propertyIds) }, isDeleted: { $ne: true } };
  }
  if (!match) return emptyStats;

  const startBound = range?.startDate
    ? (DateUtil.startOfDayEST(range.startDate) || DateUtil.toUTC(range.startDate))
    : null;
  const endBound = range?.endDate
    ? (DateUtil.endOfDayEST(range.endDate) || DateUtil.toUTC(range.endDate))
    : null;
  const datedMatch = (startBound && endBound)
    ? { ...match, createdAt: { $gte: startBound, $lte: endBound } }
    : match;

  const stats = await MaintenanceRequest.aggregate([
    { $match: datedMatch },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  // Align with MaintenanceCard + vendor dashboard:
  // Open = Open + InProgress (active), Resolved = Resolved + Completed (closed).
  const maintenanceStats = summarizeDashboardMaintenanceStatusRows(stats);

  if (!includeTrend) {
    maintenanceStats.monthlyTrend = [];
    maintenanceStats.avgPerMonth = '0.0';
    return maintenanceStats;
  }
  
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  const todayParts = parseAppYmd(todayKey) || { y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() + 1, d: 1 };

  // Trend months covering the selected range (fallback: last 6 calendar months)
  let trendStartDate = startBound;
  let trendEndDate = endBound || ClockService.now();
  if (!trendStartDate) {
    let trendStartY = todayParts.y;
    let trendStartM = todayParts.m - 5;
    while (trendStartM <= 0) {
      trendStartM += 12;
      trendStartY -= 1;
    }
    trendStartDate = parseDateOnlyToNoonUtc(`${trendStartY}-${String(trendStartM).padStart(2, '0')}-01`);
  }
  const trendStartKey = getDateKeyInTimeZone(trendStartDate) || todayKey;
  const trendEndKey = getDateKeyInTimeZone(trendEndDate) || todayKey;
  const trendStartParts = parseAppYmd(trendStartKey) || todayParts;
  const trendEndParts = parseAppYmd(trendEndKey) || todayParts;

  let cursorY = trendStartParts.y;
  let cursorM = trendStartParts.m;
  const trendMonths = [];
  while (
    (cursorY < trendEndParts.y || (cursorY === trendEndParts.y && cursorM <= trendEndParts.m)) &&
    trendMonths.length < 24
  ) {
    trendMonths.push({ year: cursorY, month: cursorM });
    cursorM += 1;
    if (cursorM > 12) {
      cursorM = 1;
      cursorY += 1;
    }
  }
  if (trendMonths.length === 0) {
    trendMonths.push({ year: todayParts.y, month: todayParts.m });
  }

  const monthlyData = await MaintenanceRequest.aggregate([
    { $match: datedMatch },
    {
      $group: {
        _id: {
          year: { $year: { date: '$createdAt', timezone: HOA_MONGO_TIMEZONE_FOR_DATE_EXPR } },
          month: { $month: { date: '$createdAt', timezone: HOA_MONGO_TIMEZONE_FOR_DATE_EXPR } },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  const monthlyTrend = [];
  let totalCount = 0;

  for (const { year, month } of trendMonths) {
    const monthStart = parseDateOnlyToNoonUtc(`${year}-${String(month).padStart(2, '0')}-01`);
    const monthName = formatDateInAppTimezone(monthStart, { day: undefined, year: undefined });
    const data = monthlyData.find(d => d._id.year === year && d._id.month === month);
    const count = data ? data.count : 0;
    totalCount += count;
    monthlyTrend.push({ month: monthName, count });
  }

  maintenanceStats.monthlyTrend = monthlyTrend;
  maintenanceStats.avgPerMonth = (totalCount / Math.max(trendMonths.length, 1)).toFixed(1);

  return maintenanceStats;
}

/**
 * Public service: returns dashboard summary for a landlord for the last 3 months.
 * Input: { landlordId }
 * Output: includes month-wise collection stats for the last 3 months
 *
 * @deprecated-response-fields (HOA, target removal 2027-01-01)
 * - `unsignedLease` - always `[]`; use owners + fee invoices instead. See hoa-lease-removal.md.
 */
async function getDashboardSummary({ landlordId, startDate, endDate, preset, hoaContext = null, req = null }) {
  const endDashboard = markPerfStart(req, 'dashboardTotal');
  let months = [];
  let calculatedStartDate, calculatedEndDate;
  
  // Calculate date range based on preset or use custom dates
  // Bounds are inclusive: startDate >= year/period start, endDate <= selected day EOD (YTD ends today).
  let rangeStartYmd;
  let rangeEndYmd;
  if (preset) {
    const { start, end } = resolveDateRangePreset(preset);
    rangeStartYmd = DateUtil.calendarDateKeyFromFilterValue(start);
    rangeEndYmd = DateUtil.calendarDateKeyFromFilterValue(end);
  } else if (startDate && endDate) {
    rangeStartYmd = DateUtil.calendarDateKeyFromFilterValue(startDate);
    rangeEndYmd = DateUtil.calendarDateKeyFromFilterValue(endDate);
  } else {
    // Default: last 3 months
    const { start, end } = resolveDateRangePreset('last_3_months');
    rangeStartYmd = DateUtil.calendarDateKeyFromFilterValue(start);
    rangeEndYmd = DateUtil.calendarDateKeyFromFilterValue(end);
  }

  calculatedStartDate = DateUtil.startOfDayEST(rangeStartYmd) || DateUtil.toUTC(rangeStartYmd);
  calculatedEndDate = DateUtil.endOfDayEST(rangeEndYmd) || DateUtil.toUTC(rangeEndYmd);

  // Format date range label
  const formatDate = (date) => formatDateInAppTimezone(date, { day: 'numeric', month: 'short', year: 'numeric' });

  const dateRangeLabel = `${formatDate(calculatedStartDate)} - ${formatDate(calculatedEndDate)}`;

  months.push({
    year: (parseAppYmd(rangeStartYmd) || {}).y ?? calculatedStartDate.getUTCFullYear(),
    month: ((parseAppYmd(rangeStartYmd) || {}).m ?? (calculatedStartDate.getUTCMonth() + 1)) - 1,
    monthName: dateRangeLabel,
    startDate: calculatedStartDate,
    endDate: calculatedEndDate,
    startKey: rangeStartYmd,
    endKey: rangeEndYmd,
  });

  // Properties and unit counts
  const { properties, propertyIds, totalUnits } = await fetchPropertiesAndUnitCount(landlordId, hoaContext);

  const [
    { occupiedUnits },
    maintenanceStats,
    allTimeMaintenanceRaw,
    openMaintenanceRequests,
    latestApplications,
  ] = await Promise.all([
    calculateOccupancy(propertyIds),
    fetchMaintenanceStats(propertyIds, hoaContext, {
      startDate: calculatedStartDate,
      endDate: calculatedEndDate,
    }),
    fetchMaintenanceStats(propertyIds, hoaContext, { includeTrend: false }),
    fetchOpenMaintenance(propertyIds, LATEST_MAINTENANCE_REQUESTS, hoaContext),
    propertyIds && propertyIds.length > 0
      ? Application.find({ property_id: { $in: toObjectIdArray(propertyIds) }, isDeleted: { $ne: true }, status: 'submitted' })
        .sort({ createdAt: -1 })
        .limit(LATEST_APPLICATIONS)
        .select('_id property_id personalInformation addressInformation status createdAt')
        .lean()
      : Promise.resolve([]),
  ]);

  const vacantUnits = Math.max(0, totalUnits - occupiedUnits);

  const unitsWithOverdueCount = await invoiceService.countUnitsWithOverdueBalance({
    landlordId,
    userContext: hoaContext,
  });

  // Fetch month-wise collection stats via lean invoice summary (avoid loading full invoice list)
  const endMonthlyStats = markPerfStart(req, 'dashboardMonthlyStats');
  const monthlyStats = await Promise.all(
    months.map(async (monthData) => {
      try {
        const startKey = monthData.startKey || DateUtil.calendarDateKeyFromFilterValue(monthData.startDate);
        const endKey = monthData.endKey || DateUtil.calendarDateKeyFromFilterValue(monthData.endDate);
        const invoiceResult = await invoiceService.getInvoiceDashboardSummary({
          landlordId,
          startDate: startKey,
          endDate: endKey,
          userContext: hoaContext,
        });

        const summary = invoiceResult.hoaBoardSummary || invoiceResult.landlordSummary || {};

        return {
          month: monthData.monthName,
          year: monthData.year,
          collectionSummary: {
            collectedAmount: summary.collectedAmount || 0,
            processingAmount: summary.processingAmount || 0,
            partiallyPaidAmount: summary.partiallyPaidAmount || 0,
            overdueAmount: summary.overdueAmount || 0,
            pastOverdueAmount: summary.pastOverdueAmount || 0,
            pastOverdueCount: summary.pastOverdueCount || 0,
            comingDueAmount: summary.comingDueAmount || 0,
            dueTodayAmount: summary.dueTodayAmount || 0,
            totalInvoiceAmount: summary.totalInvoiceAmount || 0,
            waivedAmount: summary.waivedAmount || 0,
          },
          unitsWithOverdueCount: Math.min(totalUnits, unitsWithOverdueCount),
          totalUnits,
          totalProperties: properties.length,
        };
      } catch (err) {
        logger.error(`Error fetching invoices for ${monthData.monthName}:`, err);
        return {
          month: monthData.monthName,
          year: monthData.year,
          collectionSummary: {
            collectedAmount: 0,
            processingAmount: 0,
            partiallyPaidAmount: 0,
            overdueAmount: 0,
            pastOverdueAmount: 0,
            pastOverdueCount: 0,
            comingDueAmount: 0,
            dueTodayAmount: 0,
            totalInvoiceAmount: 0,
            waivedAmount: 0,
          },
          unitsWithOverdueCount: Math.min(totalUnits, unitsWithOverdueCount),
          totalUnits,
          totalProperties: properties.length,
        };
      }
    })
  );
  endMonthlyStats();

  const allTimeMaintenanceStats = {
    opened: Number(allTimeMaintenanceRaw?.open) || 0,
    closed: Number(allTimeMaintenanceRaw?.resolved) || 0,
  };

  /** @deprecated Use allTimeMaintenanceStats - kept for backward compatibility during rollout */
  const priorPeriodMaintenanceStats = allTimeMaintenanceStats;

  endDashboard();

  return {
    occupancy: { totalProperties: properties.length, totalUnits, occupiedUnits, vacantUnits },
    openMaintenanceRequests,
    maintenanceStats,
    allTimeMaintenanceStats,
    priorPeriodMaintenanceStats,
    monthlyStats,
    /** @deprecated HOA - always empty; leases not used. Removal planned 2027-01-01. */
    unsignedLease: [],
    latestApplications,
  };
}

/**
 * Get recent activity using the new activity logging system
 * 
 * This function replaces the legacy activity fetching with the new centralized
 * activity logging system. It provides:
 * 
 * 1. Role-based Activity Filtering:
 *    - HOA Board Members: Only see HOA-specific activities
 *    - Landlords: See activities related to their properties
 *    - Automatic role detection from user record
 * 
 * 2. Fallback Mechanism:
 *    - If new activity system fails, falls back to legacy method
 *    - Ensures dashboard always shows some activity data
 * 
 * 3. Property Context:
 *    - Fetches user's properties for landlord-specific filtering
 *    - Passes property IDs to activity service for proper scoping
 * 
 * @param {Object} params - Query parameters
 * @param {string} params.landlordId - User ID for activity filtering
 * @param {number} params.limit - Maximum number of activities to return (default: 10)
 * @returns {Object} - Object containing activities array
 */
async function getRecentActivity({ landlordId, limit = 10, hoaContext = null, days = 2, communityId = null }) {
  try {
    const daysNum = parseInt(days, 10);
    const validDays = Number.isFinite(daysNum) && daysNum >= 1 && daysNum <= 30 ? daysNum : 2;

    const result = await activityService.getRecentActivities({
      userId: hoaContext?.isHOABoardMember ? null : landlordId,
      limit,
      userContext: hoaContext,
      communityId: communityId || hoaContext?.hoaId || null,
      days: validDays,
    });

    return { activities: result.data };
  } catch (error) {
    logger.error('Error fetching recent activities:', error);
    return await getLegacyRecentActivity({ landlordId, limit, hoaContext, communityId });
  }
}

/**
 * Legacy recent activity method (fallback)
 * 
 * This method provides backward compatibility and serves as a fallback
 * when the new activity logging system is unavailable. It manually
 * aggregates activities from various collections:
 * 
 * Data Sources:
 * - Recent payments (invoices with status 'Paid')
 * - Recent maintenance requests
 * - Recent rental applications
 * 
 * Features:
 * - 30-day activity window
 * - Manual activity formatting with icons and colors
 * - Property-based filtering for landlords
 * - Sorted by timestamp (most recent first)
 * 
 * This method will be deprecated once the new activity system is
 * fully integrated across all modules.
 * 
 * @param {Object} params - Query parameters
 * @param {string} params.landlordId - User ID for filtering
 * @param {number} params.limit - Maximum activities to return
 * @returns {Object} - Object containing formatted activities array
 */
async function getLegacyRecentActivity({ landlordId, limit = 10, hoaContext = null, communityId = null }) {
  const { propertyIds } = await fetchPropertiesAndUnitCount(landlordId, hoaContext);
  
  if (!propertyIds || propertyIds.length === 0) {
    return { activities: [] };
  }

  const activities = [];
  const now = ClockService.now();
  const thirtyDaysAgo = DateUtil.subtractDays(now, 30);
  const targetHoaId = communityId || hoaContext?.hoaId;

  try {
    // Get recent payments (last 30 days)
    const paymentMatch = targetHoaId
      ? {
          $or: [
            { hoaId: toObjectId(targetHoaId) },
            { propertyId: { $in: toObjectIdArray(propertyIds) } },
          ],
          status: INVOICE_STATUS.PAID,
          paidOn: { $gte: thirtyDaysAgo }
        }
      : {
          $or: [
            { propertyId: { $in: toObjectIdArray(propertyIds) } },
            { property_id: { $in: toObjectIdArray(propertyIds) } },
          ],
          status: INVOICE_STATUS.PAID,
          paidOn: { $gte: thirtyDaysAgo }
        };

    const recentPayments = await Income.find(paymentMatch)
    .sort({ paidOn: -1 })
    .limit(limit)
    .populate('propertyId', 'name')
    .populate('property_id', 'name')
    .lean();

    recentPayments.forEach(payment => {
      activities.push({
        id: payment._id,
        type: 'payment',
        title: 'Payment Received',
        description: `${payment.propertyId?.name || payment.property_id?.name || 'Property'} - $${payment.subAmount || 0} ${payment.type}`,
        time: formatTimeAgo(payment.paidOn),
        timestamp: payment.paidOn,
        icon: 'DollarSign',
        color: 'text-green-500',
        bgColor: 'bg-green-500/10'
      });
    });

    // Get recent maintenance requests (last 30 days)
    const recentMaintenance = await MaintenanceRequest.find({
      property_id: { $in: toObjectIdArray(propertyIds) },
      createdAt: { $gte: thirtyDaysAgo }
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('property_id', 'name')
    .lean();

    recentMaintenance.forEach(request => {
      activities.push({
        id: request._id,
        type: 'maintenance',
        title: 'Maintenance Request',
        description: `${request.property_id?.name || 'Property'} - ${request.title || request.description}`,
        time: formatTimeAgo(request.createdAt),
        timestamp: request.createdAt,
        icon: 'Wrench',
        color: 'text-blue-500',
        bgColor: 'bg-blue-500/10'
      });
    });

    // HOA dashboard does not surface lease activity.
    // Get recent applications (last 30 days)
    const recentApplications = await Application.find({
      property_id: { $in: toObjectIdArray(propertyIds) },
      createdAt: { $gte: thirtyDaysAgo },
      isDeleted: { $ne: true }
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('property_id', 'name')
    .lean();

    recentApplications.forEach(app => {
      const applicantName = app.personalInformation ? 
        `${app.personalInformation.firstName || ''} ${app.personalInformation.lastName || ''}`.trim() : 'Applicant';
      
      activities.push({
        id: app._id,
        type: 'application',
        title: 'Application Submitted',
        description: `${app.property_id?.name || 'Property'} - ${applicantName}`,
        time: formatTimeAgo(app.createdAt),
        timestamp: app.createdAt,
        icon: 'UserCheck',
        color: 'text-indigo-500',
        bgColor: 'bg-indigo-500/10'
      });
    });

  } catch (error) {
    logger.error('Error fetching recent activities:', error);
  }

  // Sort all activities by timestamp (most recent first) and limit
  const sortedActivities = activities
    .sort((a, b) => (DateUtil.toEpoch(b.timestamp) || 0) - (DateUtil.toEpoch(a.timestamp) || 0))
    .slice(0, limit);

  return { activities: sortedActivities };
}

/**
 * Format timestamp to relative time string
 */
function formatTimeAgo(date) {
  const now = ClockService.now();
  const then = DateUtil.toUTC(date);
  if (!then) return '';
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return formatDateInAppTimezone(date);
}

module.exports = {
  getDashboardSummary,
  getRecentActivity,
  getLegacyRecentActivity,
  summarizeDashboardMaintenanceStatusRows,
  logActivity: activityService.logActivity
};
