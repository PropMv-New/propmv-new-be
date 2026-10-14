/**
 * ------------------------------------------------------------------
 * File: dashboard.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * dashboard.controller
 * ------------------------------------------------------------------
 */

const Property = require('../../property/model/property.model');
const Lease = require('../../leasing/model/lease.model');
const Income = require('../../invoice/model/invoice.model');
const MaintenanceRequest = require('../../../../../shared/modules/maintenance/model/maintenanceRequest.model');
const Application = require('../../application/models/application.model');
const User = require('../../../../../shared/modules/users/models/user.model');

const { LEASE_STATUSES } = require('../../../../../common/constants/lease');
const { MAINTENANCE_STATUS, MAINTENANCE_REQUEST_STATUS } = require('../../../../../common/constants/property');
const { INVOICE_STATUS, INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { LATEST_SUBMITTED_LEASES, LATEST_MAINTENANCE_REQUESTS, LATEST_APPLICATIONS } = require('../../../../../common/constants/dashboard');
const { unitDisplayNameFromMaintenance } = require('../../../../../common/helpers/propertyUnitReference');
const {
  findPropertiesByCreatedBy,
  requireCreatedBy,
} = require('../../../../../shared/utils/creatorScope.util');
const { aggregateFinanceSummary } = require('../../../../../shared/utils/invoiceFinanceBuckets');
const {
  resolveLandlordInvoicePropertyIds,
  buildLandlordInvoiceBaseFilter,
  buildLandlordFinanceSummary,
} = require('../../../../../shared/utils/landlordFinanceSummary.util');
const {
  getDateKeyInTimeZone,
  parseAppYmd,
  parseDateOnlyToNoonUtc,
  getEndOfDayInAppTimezone,
  formatMonthYearInAppTimezone,
  lastDayOfAppMonth,
} = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../../common/date');

// Note: request-level validation (presence and date formats/order) is handled by Joi
// in the route middleware. Service will assume inputs are present and valid ISO dates.

/**
 * Fetch properties for a landlord and return the property ids and total units count.
 */
async function fetchPropertiesAndUnitCount(createdBy) {
  const properties = await findPropertiesByCreatedBy(Property, createdBy, '_id unitDetails');
  const propertyIds = properties.map(p => p._id);
  const totalUnits = properties.reduce((sum, p) => sum + ((p.unitDetails && p.unitDetails.length) || 0), 0);
  return { properties, propertyIds, totalUnits };
}

/**
 * Count occupied units by inspecting active and approved leases.
 * Returns the number of occupied units (unique propertyId+unit pairs).
 * A unit is considered occupied if it has a lease with status Active or Approved.
 * When a date range is provided, only leases overlapping that period are counted.
 */
async function calculateOccupancy(propertyIds, { from, to, applyDateFilter } = {}) {
  if (!propertyIds || propertyIds.length === 0) return { occupiedUnits: 0 };

  const baseQuery = {
    property_id: { $in: propertyIds },
    status: { $in: [LEASE_STATUSES.ACTIVE, LEASE_STATUSES.APPROVED] },
    isDeleted: { $ne: true },
  };

  let leaseQuery = baseQuery;
  if (applyDateFilter && from && to) {
    leaseQuery = {
      ...baseQuery,
      start_date: { $lte: to },
      $or: [
        { end_date: { $gte: from } },
        { end_date: null },
        { end_date: { $exists: false } },
      ],
    };
  }

  const occupiedLeases = await Lease.find(leaseQuery)
    .select('property_id unitId unitName')
    .lean();

  const occupiedSet = new Set(
    occupiedLeases.map((l) => {
      const key = l.unitId ? String(l.unitId) : (l.unitName || '').toString();
      return `${String(l.property_id)}::${key}`;
    })
  );

  return { occupiedUnits: occupiedSet.size };
}

/**
 * Build a MongoDB match object for invoice aggregation scoped by property ids.
 */
function buildPaymentsMatch(propertyIds, from, to) {
  return buildLandlordInvoiceBaseFilter(propertyIds, { startDate: from, endDate: to });
}

/**
 * Aggregate income records using the same scope and rules as the income listing overview.
 */
async function buildCollectionSummary(propertyIds, from, to) {
  const paymentsMatch = buildPaymentsMatch(propertyIds, from, to);
  if (!paymentsMatch) {
    return {
      collectedAmount: 0,
      processingAmount: 0,
      overdueAmount: 0,
      comingDueAmount: 0,
    };
  }

  const invoices = await Income.find(paymentsMatch)
    .select('status subAmount balanceDue dueDate')
    .lean();

  const aggregated = aggregateFinanceSummary(invoices);
  return {
    collectedAmount: aggregated.collectedAmount,
    processingAmount: aggregated.processingAmount,
    overdueAmount: aggregated.overdueAmount,
    comingDueAmount: aggregated.comingDueAmount,
  };
}

/**
 * Returns the count of distinct leases (units) that have overdue balances within the date range.
 */
async function fetchUnitsWithOverdueCount(propertyIds, from, to) {
  const paymentsMatch = buildPaymentsMatch(propertyIds, from, to);
  if (!paymentsMatch) return 0;

  const todayStart = DateUtil.startOfDayEST(ClockService.now());
  paymentsMatch.balanceDue = { $gt: 0 };
  paymentsMatch.dueDate = Object.assign(
    {},
    paymentsMatch.dueDate || {},
    { $lt: todayStart }
  );
  paymentsMatch.status = { $ne: INVOICE_STATUS.PAID };

  const agg = await Income.aggregate([
    { $match: paymentsMatch },
    { $group: { _id: '$lease_id' } },
    { $count: 'count' },
  ]);

  return agg && agg[0] && agg[0].count ? agg[0].count : 0;
}

/**
 * Fetch open maintenance requests for the given properties.
 */
async function fetchOpenMaintenance(propertyIds) {
  // Accept an optional `limit` parameter to return only the most recent requests
  // If limit is not provided or <= 0, return all open maintenance requests.
  const args = Array.from(arguments);
  const limit = args.length > 1 ? args[1] : 0;
  if (!propertyIds || propertyIds.length === 0) return [];
  
  // Use actual model enum values from MAINTENANCE_REQUEST_STATUS
  const openStatuses = [MAINTENANCE_REQUEST_STATUS.OPEN];

  let query = MaintenanceRequest.find({ property_id: { $in: propertyIds }, status: { $in: openStatuses }, isDeleted: { $ne: true } })
    .sort({ createdAt: -1 })
    .populate('property_id', 'name unitDetails')
    .populate('requestedBy', 'firstName lastName email phone')
    .populate('assignedTo', 'firstName lastName email phone')
    .select('_id property_id unitId units title description category status priority request_date requestedBy assignedTo estimatedCost isUrgent createdAt');
    
  if (limit && Number(limit) > 0) query = query.limit(Number(limit));
  
  const requests = await query.lean();

  // Format the response to match the expected structure
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
    priority: req.priority,
    status: req.status,
    description: req.description,
    dateCreated: req.createdAt || req.request_date,
    estimatedCost: req.estimatedCost || 0,
    assignedTo: req.assignedTo ? `${req.assignedTo.firstName || ''} ${req.assignedTo.lastName || ''}`.trim() : null,
    images: [] // Add images if needed from documents field
    };
  });
}

/**
 * get Month Range
 *
 * Performs logic operations for getMonthRange.
 *
 * @param year - Request/input argument
 * @param month - Request/input argument
 * @returns Operations result
 */
function getMonthRange(year, month) {
  const startYmd = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = lastDayOfAppMonth(year, month);
  const endYmd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return {
    startYmd,
    endYmd,
    startDate: parseDateOnlyToNoonUtc(startYmd),
    endDate: getEndOfDayInAppTimezone(endYmd),
  };
}

/**
 * get Current Month Range
 *
 * Performs logic operations for getCurrentMonthRange.
 *
 * @returns Operations result
 */
function getCurrentMonthRange() {
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  const parts = parseAppYmd(todayKey);
  if (!parts) {
    const fallbackKey = DateUtil.toEST(ClockService.now());
    const fallbackParts = parseAppYmd(fallbackKey);
    if (!fallbackParts) return getMonthRange(ClockService.now().getUTCFullYear(), ClockService.now().getUTCMonth() + 1);
    return getMonthRange(fallbackParts.y, fallbackParts.m);
  }
  return getMonthRange(parts.y, parts.m);
}

/**
 * parse Period
 *
 * Performs logic operations for parsePeriod.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function parsePeriod({ startDate, endDate }) {
  if (startDate && endDate) {
    const from = DateUtil.toUTC(startDate);
    const to = DateUtil.toUTC(endDate);
    if (!from || !to) {
      return { from: null, to: null, source: 'custom', applyDateFilter: false };
    }
    return {
      from,
      to,
      source: 'custom',
      applyDateFilter: true,
    };
  }
  if (!startDate && !endDate) {
    return { from: null, to: null, source: 'all', applyDateFilter: false };
  }
  const current = getCurrentMonthRange();
  return {
    from: current.startDate,
    to: current.endDate,
    source: 'current_month',
    applyDateFilter: true,
  };
}

/**
 * build Maintenance Date Filter
 *
 * Performs logic operations for buildMaintenanceDateFilter.
 *
 * @param from - Request/input argument
 * @param to - Request/input argument
 * @param applyDateFilter - Request/input argument
 * @returns Operations result
 */
function buildMaintenanceDateFilter(from, to, applyDateFilter) {
  if (!applyDateFilter || !from || !to) return {};
  return {
    $or: [
      { request_date: { $gte: from, $lte: to } },
      { request_date: { $exists: false }, createdAt: { $gte: from, $lte: to } },
    ],
  };
}

/**
 * build Created At Date Filter
 *
 * Performs logic operations for buildCreatedAtDateFilter.
 *
 * @param from - Request/input argument
 * @param to - Request/input argument
 * @param applyDateFilter - Request/input argument
 * @returns Operations result
 */
function buildCreatedAtDateFilter(from, to, applyDateFilter) {
  if (!applyDateFilter || !from || !to) return {};
  return { createdAt: { $gte: from, $lte: to } };
}

/**
 * build Recent Three Months
 *
 * Performs logic operations for buildRecentThreeMonths.
 *
 * @returns Operations result
 */
function buildRecentThreeMonths() {
  const todayKey = getDateKeyInTimeZone(ClockService.now());
  const parts = parseAppYmd(todayKey);
  if (!parts) return [];
  const { y, m } = parts;
  const months = [];
  for (let i = 2; i >= 0; i--) {
    let month = m - i;
    let year = y;
    while (month <= 0) {
      year -= 1;
      month += 12;
    }
    const monthRange = getMonthRange(year, month);
    months.push({
      year,
      month,
      monthName: formatMonthYearInAppTimezone(
        parseDateOnlyToNoonUtc(`${year}-${String(month).padStart(2, '0')}-01`),
        { longMonth: true }
      ),
      startYmd: monthRange.startYmd,
      endYmd: monthRange.endYmd,
      startDate: monthRange.startDate,
      endDate: monthRange.endDate,
    });
  }
  return months;
}

/**
 * Public service: returns dashboard summary for an owner for the last 3 months.
 * Input: { createdBy }
 * Output: includes month-wise collection stats for the last 3 months
 */
async function getDashboardSummary({ createdBy, startDate, endDate }) {
  const ownerId = requireCreatedBy({ createdBy });
  const { from, to, source, applyDateFilter } = parsePeriod({ startDate, endDate });
  const months = buildRecentThreeMonths();

  // Properties and unit counts
  const { properties, propertyIds, totalUnits } = await fetchPropertiesAndUnitCount(ownerId);

  const { occupiedUnits } = await calculateOccupancy(propertyIds, { from, to, applyDateFilter });
  const vacantUnits = Math.max(0, totalUnits - occupiedUnits);

  const maintenanceDateFilter = buildMaintenanceDateFilter(from, to, applyDateFilter);
  const maintenanceFilter = {
    property_id: { $in: propertyIds },
    isDeleted: { $ne: true },
    ...maintenanceDateFilter,
  };
  const allMaintenanceRequests = await MaintenanceRequest.find(maintenanceFilter).select('status').lean();
  const openMaintenanceCount = allMaintenanceRequests.filter(r => (r.status || '').toLowerCase() === 'open').length;
  const inProgressMaintenanceCount = 0;
  const resolvedMaintenanceCount = allMaintenanceRequests.filter(r => (r.status || '').toLowerCase() === 'resolved').length;
  const openMaintenanceRequests = await MaintenanceRequest.find({
    ...maintenanceFilter,
    status: MAINTENANCE_REQUEST_STATUS.OPEN,
  })
    .sort({ createdAt: -1 })
    .limit(LATEST_MAINTENANCE_REQUESTS)
    .populate('property_id', 'name unitDetails')
    .populate('requestedBy', 'firstName lastName email phone')
    .populate('assignedTo', 'firstName lastName email phone')
    .select('_id property_id unitId units title description category status priority request_date requestedBy assignedTo estimatedCost isUrgent createdAt')
    .lean();

  // Finance stats: use the same invoice scope as the income listing (property-based).
  const scopedPropertyIds = await resolveLandlordInvoicePropertyIds(ownerId);

  // Submitted (in-progress) leases for this landlord in selected period (configurable count)
  let unsignedLease = [];
  if (propertyIds && propertyIds.length > 0) {
    unsignedLease = await Lease.find({
      property_id: { $in: propertyIds },
      status: LEASE_STATUSES.SUBMITTED,
      ...buildCreatedAtDateFilter(from, to, applyDateFilter),
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .limit(LATEST_SUBMITTED_LEASES)
      .select('_id property_id unitName start_date end_date rentDetails status createdAt')
      .lean();
  }
  // Add unsignedKey field for each lease (string form of _id). Change this mapping if you
  // want unsignedKey to be computed differently (e.g., hash or combined key).
  unsignedLease = unsignedLease.map(l => ({ ...l, unsignedKey: String(l._id) }));

  // Latest applications for this landlord (based on their properties, configurable count)
  // Only fetch submitted applications
  let latestApplications = [];
  if (propertyIds && propertyIds.length > 0) {
    latestApplications = await Application.find({
      property_id: { $in: propertyIds },
      status: 'submitted',
      ...buildCreatedAtDateFilter(from, to, applyDateFilter),
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .limit(LATEST_APPLICATIONS)
      .select('_id property_id tenant_id lease_id personalInformation addressInformation status createdAt')
      .lean();
  }

  // Enrich submitted applications with assigned screening options for the linked lease tenant split.
  if (latestApplications.length > 0) {
    const leaseIds = [...new Set(latestApplications.map(a => a.lease_id).filter(Boolean).map(v => String(v)))];
    const tenantIds = [...new Set(latestApplications.map(a => a.tenant_id).filter(Boolean).map(v => String(v)))];
    const [leaseDocs, tenantUsers] = await Promise.all([
      leaseIds.length > 0
        ? Lease.find({ _id: { $in: leaseIds }, isDeleted: { $ne: true } }).select('_id rentAndDepositDestribution status').lean()
        : [],
      tenantIds.length > 0
        ? User.find({ _id: { $in: tenantIds }, isDeleted: { $ne: true } }).select('_id firstName lastName email').lean()
        : [],
    ]);
    const leaseMap = new Map(leaseDocs.map(l => [String(l._id), l]));
    const tenantMap = new Map(tenantUsers.map(u => [String(u._id), u]));
    latestApplications = latestApplications.map(app => {
      const lease = app.lease_id ? leaseMap.get(String(app.lease_id)) : null;
      const splitRows = lease?.rentAndDepositDestribution?.split || [];
      const matchedSplit = splitRows.find(s => String(s.tenantId) === String(app.tenant_id));
      const submittedFor = app.tenant_id ? tenantMap.get(String(app.tenant_id)) : null;
      return {
        ...app,
        screeningOptions: Array.isArray(matchedSplit?.screening) ? matchedSplit.screening : [],
        submittedForTenant: submittedFor
          ? {
            id: submittedFor._id,
            name: `${submittedFor.firstName || ''} ${submittedFor.lastName || ''}`.trim() || submittedFor.email,
          }
          : null,
      };
    });
  }

  // Fetch month-wise collection stats in parallel
  const monthlyStats = await Promise.all(
    months.map(async (monthData) => {
      const [collectionSummary, unitsWithOverdueCount] = await Promise.all([
        buildCollectionSummary(scopedPropertyIds, monthData.startYmd, monthData.endYmd),
        fetchUnitsWithOverdueCount(scopedPropertyIds, monthData.startYmd, monthData.endYmd),
      ]);
      return {
        month: monthData.monthName,
        year: monthData.year,
        collectionSummary,
        unitsWithOverdueCount,
      };
    })
  );

  const selectedPeriodFinance = await buildLandlordFinanceSummary(ownerId, {
    startDate: applyDateFilter ? from : undefined,
    endDate: applyDateFilter ? to : undefined,
  });
  const selectedPeriodUnitsOverdueCount = await fetchUnitsWithOverdueCount(
    scopedPropertyIds,
    applyDateFilter ? from : null,
    applyDateFilter ? to : null,
  );
  const selectedFinanceStats = {
    ...selectedPeriodFinance,
    unitsWithOverdueCount: selectedPeriodUnitsOverdueCount,
  };

  return {
    occupancy: { totalProperties: properties.length, totalUnits, occupiedUnits, vacantUnits },
    selectedPeriod: {
      startDate: applyDateFilter ? from : null,
      endDate: applyDateFilter ? to : null,
      source,
    },
    financeStats: selectedFinanceStats,
    openMaintenanceRequests: openMaintenanceRequests.map(req => {
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
      priority: req.priority,
      status: req.status,
      description: req.description,
      dateCreated: req.createdAt || req.request_date,
      estimatedCost: req.estimatedCost || 0,
      assignedTo: req.assignedTo ? `${req.assignedTo.firstName || ''} ${req.assignedTo.lastName || ''}`.trim() : null,
      images: [],
      };
    }),
    openMaintenanceCount,
    inProgressMaintenanceCount,
    resolvedMaintenanceCount,
    monthlyStats,
    unsignedLease,
    latestApplications,
  };
}

module.exports = {
  getDashboardSummary,
};
