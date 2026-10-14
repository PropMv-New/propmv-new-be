'use strict';

const mongoose = require('mongoose');
const HOA = require('../../../../../portals/hoa-board/modules/hoa/model/hoa.model');
const HOAProperty = require('../../../../../portals/hoa-board/modules/property/model/property.model');
const HOASettings = require('../../../../../portals/hoa-board/modules/hoa-settings/model/hoaSettings.model');
const User = require('../../../users/models/user.model');
const { ClockService, DateUtil, TIMEZONE } = require('../../../../../common/date');
const hoaOwnerRoleHelper = require('../../../../../common/helpers/hoaOwnerRole');
const hoaStatusHelper = require('../../../../../portals/hoa-board/modules/hoa/helpers/hoaOnboardingStatus.helper');
const logger = require('../../../../../common/logger');

function reportTimezone() {
  return (
    process.env.HOA_ONBOARDING_REPORT_TIMEZONE ||
    process.env.APP_TIMEZONE ||
    TIMEZONE.BUSINESS ||
    'America/New_York'
  );
}

function startOfYmdUtc(ymd, timeZone) {
  return DateUtil.calendarDateTimeInTimezoneToUtc(ymd, 0, 0, 0, timeZone);
}

function endOfYmdUtc(ymd, timeZone) {
  const next = DateUtil.shiftYmdDays(ymd, 1, timeZone);
  return DateUtil.calendarDateTimeInTimezoneToUtc(next, 0, 0, 0, timeZone);
}

/**
 * Compute reporting calendar windows in America/New_York.
 * - Daily: Today 00:00:00 to tomorrow 00:00:00
 * - Weekly: Trailing 7 days (today - 6 days) to tomorrow 00:00:00
 * - Monthly: Month-to-date (1st of current month) to tomorrow 00:00:00
 */
function buildPeriodWindows(referenceDate = ClockService.now()) {
  const timeZone = reportTimezone();
  const todayKey = DateUtil.getDateKeyInTimeZone(referenceDate, timeZone);
  const weekStartKey = DateUtil.shiftYmdDays(todayKey, -6, timeZone);
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;

  return {
    timeZone,
    todayKey,
    windows: {
      daily: {
        label: 'Daily',
        start: startOfYmdUtc(todayKey, timeZone),
        end: endOfYmdUtc(todayKey, timeZone),
      },
      weekly: {
        label: 'Weekly',
        start: startOfYmdUtc(weekStartKey, timeZone),
        end: endOfYmdUtc(todayKey, timeZone),
      },
      monthly: {
        label: 'Monthly',
        start: startOfYmdUtc(monthStartKey, timeZone),
        end: endOfYmdUtc(todayKey, timeZone),
      },
    },
  };
}

/**
 * Single-pass MongoDB $facet aggregation for summary counts (today, this week, this month).
 * Avoids loading historical records into memory and avoids 3 separate collection queries.
 */
async function getHoaOnboardingSummary(referenceDate = ClockService.now()) {
  const { timeZone, todayKey, windows } = buildPeriodWindows(referenceDate);

  const [facetResult] = await HOA.aggregate([
    { $match: { isDeleted: { $ne: true } } },
    {
      $facet: {
        today: [
          {
            $match: {
              createdAt: { $gte: windows.daily.start, $lt: windows.daily.end },
            },
          },
          { $count: 'count' },
        ],
        thisWeek: [
          {
            $match: {
              createdAt: { $gte: windows.weekly.start, $lt: windows.weekly.end },
            },
          },
          { $count: 'count' },
        ],
        thisMonth: [
          {
            $match: {
              createdAt: { $gte: windows.monthly.start, $lt: windows.monthly.end },
            },
          },
          { $count: 'count' },
        ],
      },
    },
  ]);

  return {
    reportDate: todayKey,
    timezone: timeZone,
    today: facetResult?.today?.[0]?.count || 0,
    thisWeek: facetResult?.thisWeek?.[0]?.count || 0,
    thisMonth: facetResult?.thisMonth?.[0]?.count || 0,
    periodStarts: {
      daily: windows.daily.start,
      weekly: windows.weekly.start,
      monthly: windows.monthly.start,
    },
    periodEnd: windows.daily.end,
  };
}

/**
 * Batch-enrich a list of HOA documents with:
 * - Creator details (firstName, lastName, email, soft-delete awareness)
 * - Actual unit/property count from persisted HOAProperty records
 * - Deterministic owner count (HOA Owner role only, excluding board members)
 * - Derived onboarding status (active, in_progress, pending_setup, deleted)
 */
async function enrichHoaBatch(hoas = []) {
  if (!Array.isArray(hoas) || hoas.length === 0) {
    return [];
  }

  const hoaIds = hoas.map((h) => h._id);
  const hoaIdStrings = hoaIds.map((id) => String(id));

  // 1. Resolve creators
  const createdByUserIds = [
    ...new Set(hoas.map((h) => h.createdBy).filter(Boolean).map((id) => String(id))),
  ];

  const creators = await User.find({ _id: { $in: createdByUserIds } })
    .select('_id firstName lastName email isDeleted')
    .lean();

  const creatorMap = new Map(
    creators.map((u) => {
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      return [
        String(u._id),
        {
          id: String(u._id),
          name: name || u.email || 'Unknown',
          fullName: name || '',
          email: u.email || '',
          isDeleted: Boolean(u.isDeleted),
        },
      ];
    })
  );

  // 2. Fetch properties for all HOAs in the batch (unit & property counting)
  const properties = await HOAProperty.find({
    hoaId: { $in: hoaIds },
    isDeleted: { $ne: true },
    isArchieved: { $ne: true },
  })
    .select('_id hoaId associatedOwnerIds')
    .lean();

  // Group properties and collect owner IDs per HOA
  const propertiesByHoa = new Map();
  const propertyOwnerIdsByHoa = new Map();
  const allPropertyOwnerIds = new Set();

  for (const idStr of hoaIdStrings) {
    propertiesByHoa.set(idStr, 0);
    propertyOwnerIdsByHoa.set(idStr, new Set());
  }

  for (const prop of properties) {
    const hKey = String(prop.hoaId);
    if (propertiesByHoa.has(hKey)) {
      propertiesByHoa.set(hKey, propertiesByHoa.get(hKey) + 1);
    }
    const ownerSet = propertyOwnerIdsByHoa.get(hKey);
    if (ownerSet && Array.isArray(prop.associatedOwnerIds)) {
      for (const oId of prop.associatedOwnerIds) {
        if (oId) {
          const oStr = String(oId);
          ownerSet.add(oStr);
          allPropertyOwnerIds.add(oStr);
        }
      }
    }
  }

  // 3. Resolve Owner Count (HOA Owner role only; DO NOT use HOAMembership)
  let hoaOwnerRoleId = null;
  try {
    const refs = await hoaOwnerRoleHelper.getHOAOwnerRoleRefs();
    hoaOwnerRoleId = refs?.roleId ? String(refs.roleId) : null;
  } catch (err) {
    logger.warn('[hoaOnboardingReport] getHOAOwnerRoleRefs failed; using role name heuristics', {
      error: err.message,
    });
  }

  const ownerUserQuery = {
    isDeleted: { $ne: true },
    $or: [
      { 'hoaInfo.hoaId': { $in: hoaIds } },
      ...(allPropertyOwnerIds.size > 0
        ? [{ _id: { $in: Array.from(allPropertyOwnerIds) } }]
        : []),
    ],
  };

  const candidateUsers = await User.find(ownerUserQuery)
    .select('_id hoaInfo role companyRoleId')
    .lean();

  // Filter to verified HOA Owners only (not board members, tenants, etc.)
  const verifiedOwnerMap = new Map();
  for (const user of candidateUsers) {
    const matchesRoleId = hoaOwnerRoleId && String(user.companyRoleId || '') === hoaOwnerRoleId;
    const matchesRoleName = hoaOwnerRoleHelper.isHOAOwnerRole(user.role);
    if (matchesRoleId || matchesRoleName) {
      verifiedOwnerMap.set(String(user._id), user);
    }
  }

  // Count unique verified owners per HOA
  const ownerCountsByHoa = new Map();
  for (const idStr of hoaIdStrings) {
    const distinctOwners = new Set();

    // Add owners linked via hoaInfo.hoaId
    for (const [userId, user] of verifiedOwnerMap.entries()) {
      if (user.hoaInfo?.hoaId && String(user.hoaInfo.hoaId) === idStr) {
        distinctOwners.add(userId);
      }
    }

    // Add owners referenced in property associatedOwnerIds
    const propOwners = propertyOwnerIdsByHoa.get(idStr) || new Set();
    for (const ownerId of propOwners) {
      if (verifiedOwnerMap.has(ownerId)) {
        distinctOwners.add(ownerId);
      }
    }

    ownerCountsByHoa.set(idStr, distinctOwners.size);
  }

  // 4. Resolve Onboarding Status using hoaOnboardingStatus.helper
  const [settingsList, bankSummaries] = await Promise.all([
    HOASettings.find({ hoaId: { $in: hoaIds } }).lean(),
    Promise.all(
      hoaIds.map(async (id) => {
        try {
          const summary = await hoaStatusHelper.summarizeCommunityLinkedBanks(id);
          return [String(id), summary];
        } catch {
          return [String(id), { hasLinkedBank: false, hasActiveLinkedBank: false }];
        }
      })
    ),
  ]);

  const settingsByHoa = new Map(
    settingsList.map((s) => [String(s.hoaId), s])
  );
  const banksByHoa = new Map(bankSummaries);

  // 5. Assemble enriched items
  return hoas.map((hoa) => {
    const key = String(hoa._id);
    const creator = creatorMap.get(String(hoa.createdBy)) || {
      id: hoa.createdBy ? String(hoa.createdBy) : null,
      name: 'Unknown User',
      fullName: '',
      email: '',
      isDeleted: false,
    };

    const propertyCount = propertiesByHoa.get(key) || 0;
    const ownerCount = ownerCountsByHoa.get(key) || 0;
    const settings = settingsByHoa.get(key);
    const settingsConfigured = hoaStatusHelper.isHoaSettingsComplete(settings);
    const bankSummary = banksByHoa.get(key) || {
      hasLinkedBank: false,
      hasActiveLinkedBank: false,
    };
    const hasLinkedBank = Boolean(
      bankSummary.hasActiveLinkedBank || bankSummary.hasLinkedBank
    );
    const hasProperties = propertyCount > 0;

    let derivedStatus = 'pending_setup';
    if (hoa.isDeleted === true) {
      derivedStatus = 'deleted';
    } else if (settingsConfigured && hasProperties && hasLinkedBank) {
      derivedStatus = 'active';
    } else if (settingsConfigured || hasProperties || hasLinkedBank) {
      derivedStatus = 'in_progress';
    } else {
      derivedStatus = 'pending_setup';
    }

    return {
      id: key,
      name: hoa.name || 'Untitled Community',
      createdAt: hoa.createdAt,
      createdBy: {
        id: creator.id,
        name: creator.name,
        fullName: creator.fullName || '',
        email: creator.email,
        isDeleted: creator.isDeleted,
      },
      propertyCount,
      unitCount: propertyCount, // Actual persisted units (HOA: 1 Property doc = 1 unit)
      ownerCount,
      status: derivedStatus,
      onboardingDetails: {
        hoaSettingsConfigured: settingsConfigured,
        hasProperties,
        hasLinkedBank,
      },
    };
  });
}

/**
 * Paginated, searchable, filterable HOA onboarding list.
 */
async function listHoaOnboarding(
  {
    period = 'all',
    page = 1,
    limit = 10,
    search = '',
    sortBy = 'createdAt',
    sortOrder = 'desc',
    status = 'all',
  } = {},
  referenceDate = ClockService.now()
) {
  // Validate and clamp pagination
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

  const { windows } = buildPeriodWindows(referenceDate);

  // Build Mongo filter
  const query = {};

  // Status & deleted filtering
  if (status === 'deleted') {
    query.isDeleted = true;
  } else {
    query.isDeleted = { $ne: true };
  }

  // Period window filtering
  if (period === 'today') {
    query.createdAt = { $gte: windows.daily.start, $lt: windows.daily.end };
  } else if (period === 'this_week') {
    query.createdAt = { $gte: windows.weekly.start, $lt: windows.weekly.end };
  } else if (period === 'this_month') {
    query.createdAt = { $gte: windows.monthly.start, $lt: windows.monthly.end };
  }

  // Search filter (community name or creator)
  const trimmedSearch = String(search || '').trim();
  if (trimmedSearch) {
    const searchRegex = new RegExp(trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const matchingUsers = await User.find({
      $or: [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { email: searchRegex },
      ],
    })
      .select('_id')
      .lean();

    const matchingUserIds = matchingUsers.map((u) => u._id);

    query.$or = [
      { name: searchRegex },
      ...(matchingUserIds.length > 0 ? [{ createdBy: { $in: matchingUserIds } }] : []),
    ];
  }

  // Sorting
  const sortField = sortBy === 'name' ? 'name' : 'createdAt';
  const sortDirection = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
  const sortOptions = { [sortField]: sortDirection };

  // If status is a derived non-deleted status (active, in_progress, pending_setup),
  // we query matching candidates and filter post-enrichment.
  const isDerivedStatusFilter = ['active', 'in_progress', 'pending_setup'].includes(status);

  if (isDerivedStatusFilter) {
    // Load candidates for the period/search
    const allCandidates = await HOA.find(query).sort(sortOptions).lean();
    const enrichedAll = await enrichHoaBatch(allCandidates);
    const filtered = enrichedAll.filter((item) => item.status === status);

    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / safeLimit) || 1;
    const startIndex = (safePage - 1) * safeLimit;
    const items = filtered.slice(startIndex, startIndex + safeLimit);

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalItems,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  // Standard direct Mongo pagination
  const totalItems = await HOA.countDocuments(query);
  const totalPages = Math.ceil(totalItems / safeLimit) || 1;
  const skip = (safePage - 1) * safeLimit;

  const rawHoas = await HOA.find(query)
    .sort(sortOptions)
    .skip(skip)
    .limit(safeLimit)
    .lean();

  const items = await enrichHoaBatch(rawHoas);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      totalItems,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1,
    },
  };
}

/**
 * Report builder providing full report structure for email generation and backwards compatibility.
 * Employs capped detailed rows (top 25) to avoid unbounded email payloads.
 */
async function buildHoaOnboardingReport(referenceDate = ClockService.now()) {
  const summary = await getHoaOnboardingSummary(referenceDate);
  const { windows } = buildPeriodWindows(referenceDate);

  // Fetch top 25 recent HOAs for today, weekly sample, monthly sample
  const [dailyResult, weeklyResult, monthlyResult] = await Promise.all([
    listHoaOnboarding({ period: 'today', limit: 25, sortBy: 'createdAt', sortOrder: 'desc' }, referenceDate),
    listHoaOnboarding({ period: 'this_week', limit: 25, sortBy: 'createdAt', sortOrder: 'desc' }, referenceDate),
    listHoaOnboarding({ period: 'this_month', limit: 25, sortBy: 'createdAt', sortOrder: 'desc' }, referenceDate),
  ]);

  return {
    generatedAt: ClockService.now(),
    reportDate: summary.reportDate,
    timeZone: summary.timezone,
    summary: {
      daily: summary.today,
      weekly: summary.thisWeek,
      monthly: summary.thisMonth,
    },
    periods: {
      daily: {
        ...windows.daily,
        count: summary.today,
        hoas: dailyResult.items,
      },
      weekly: {
        ...windows.weekly,
        count: summary.thisWeek,
        hoas: weeklyResult.items,
      },
      monthly: {
        ...windows.monthly,
        count: summary.thisMonth,
        hoas: monthlyResult.items,
      },
    },
  };
}

module.exports = {
  buildPeriodWindows,
  getHoaOnboardingSummary,
  enrichHoaBatch,
  listHoaOnboarding,
  buildHoaOnboardingReport,
  reportTimezone,
};
