const SiteVisit = require('../model/siteVisit.model');
const { buildLoginMetaFromRequest } = require('../../auth/helpers/loginMeta.helper');
const { ClockService, DateUtil } = require('../../../../common/date');

function sanitizeText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function startOfTodayUtc() {
  const now = ClockService.now();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function buildVisitFilter(query = {}) {
  const filter = {};
  const path = sanitizeText(query.path, 500);
  const country = sanitizeText(query.country, 100);
  const deviceType = sanitizeText(query.deviceType, 20);

  if (path) filter.path = path;
  if (country) filter.country = country;
  if (deviceType) filter.deviceType = deviceType;

  const from = query.from ? DateUtil.toUTC(query.from) : null;
  const to = query.to ? DateUtil.toUTC(query.to) : null;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  return filter;
}

async function recordSiteVisit(req, payload = {}) {
  const requestMeta = await buildLoginMetaFromRequest(req);

  return SiteVisit.create({
    visitorId: payload.visitorId,
    sessionId: payload.sessionId,
    path: payload.path,
    title: sanitizeText(payload.title, 300),
    referrer: sanitizeText(payload.referrer, 2000),
    query: sanitizeText(payload.query, 2000),
    language: sanitizeText(payload.language, 32),
    screenWidth: payload.screenWidth ?? null,
    screenHeight: payload.screenHeight ?? null,
    utmSource: sanitizeText(payload.utmSource, 200),
    utmMedium: sanitizeText(payload.utmMedium, 200),
    utmCampaign: sanitizeText(payload.utmCampaign, 200),
    ip: requestMeta.ip,
    userAgent: requestMeta.userAgent,
    browser: requestMeta.browser,
    os: requestMeta.os,
    deviceType: requestMeta.deviceType,
    city: requestMeta.city,
    state: requestMeta.state,
    country: requestMeta.country,
    timezone: requestMeta.timezone,
    isLocalDevelopment: !!requestMeta.isLocalDevelopment,
  });
}

async function getSiteVisitStats(query = {}) {
  const filter = buildVisitFilter(query);
  const todayStart = startOfTodayUtc();

  const [
    totalPageViews,
    uniqueVisitors,
    uniqueSessions,
    visitsToday,
    topPages,
    topReferrers,
    deviceBreakdown,
    countryBreakdown,
    browserBreakdown,
    recentVisits,
  ] = await Promise.all([
    SiteVisit.countDocuments(filter),
    SiteVisit.distinct('visitorId', filter).then((rows) => rows.length),
    SiteVisit.distinct('sessionId', filter).then((rows) => rows.length),
    SiteVisit.countDocuments({ ...filter, createdAt: { ...(filter.createdAt || {}), $gte: todayStart } }),
    SiteVisit.aggregate([
      { $match: filter },
      { $group: { _id: '$path', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, path: '$_id', count: 1 } },
    ]),
    SiteVisit.aggregate([
      { $match: { ...filter, referrer: { $nin: [null, ''] } } },
      { $group: { _id: '$referrer', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, referrer: '$_id', count: 1 } },
    ]),
    SiteVisit.aggregate([
      { $match: filter },
      { $group: { _id: '$deviceType', count: { $sum: 1 } } },
      { $project: { _id: 0, deviceType: '$_id', count: 1 } },
    ]),
    SiteVisit.aggregate([
      { $match: { ...filter, country: { $nin: [null, ''] } } },
      { $group: { _id: '$country', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, country: '$_id', count: 1 } },
    ]),
    SiteVisit.aggregate([
      { $match: filter },
      { $group: { _id: '$browser', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, browser: '$_id', count: 1 } },
    ]),
    SiteVisit.find(filter)
      .sort({ createdAt: -1 })
      .limit(20)
      .select(
        'visitorId sessionId path title referrer browser os deviceType country city state ip createdAt utmSource utmMedium utmCampaign'
      )
      .lean(),
  ]);

  return {
    totalPageViews,
    uniqueVisitors,
    uniqueSessions,
    visitsToday,
    topPages,
    topReferrers,
    deviceBreakdown,
    countryBreakdown,
    browserBreakdown,
    recentVisits,
  };
}

async function listSiteVisits(query = {}) {
  const filter = buildVisitFilter(query);
  const page = Number(query.page) > 0 ? Number(query.page) : 1;
  const limit = Number(query.limit) > 0 ? Math.min(Number(query.limit), 100) : 25;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    SiteVisit.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        'visitorId sessionId path title referrer query language browser os deviceType country city state timezone ip screenWidth screenHeight utmSource utmMedium utmCampaign createdAt'
      )
      .lean(),
    SiteVisit.countDocuments(filter),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

module.exports = {
  recordSiteVisit,
  getSiteVisitStats,
  listSiteVisits,
};
