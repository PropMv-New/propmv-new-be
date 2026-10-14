const EmailSubscription = require('../model/emailSubscription.model');
const { DateUtil } = require('../../../../common/date');

async function listEmailSubscriptions(query = {}) {
  const page = Number(query.page) > 0 ? Number(query.page) : 1;
  const limit = Number(query.limit) > 0 ? Math.min(Number(query.limit), 100) : 25;
  const skip = (page - 1) * limit;

  const filter = {};
  const source = String(query.source || '').trim();
  const search = String(query.search || '').trim().toLowerCase();
  const launchStatus = String(query.launchStatus || 'all').trim();

  if (source) filter.source = source;
  if (search) filter.email = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (launchStatus === 'pending') filter.launchNotifiedAt = null;
  if (launchStatus === 'notified') filter.launchNotifiedAt = { $ne: null };

  const [items, total, pendingLaunchCount] = await Promise.all([
    EmailSubscription.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('email source launchNotifiedAt createdAt updatedAt')
      .lean(),
    EmailSubscription.countDocuments(filter),
    EmailSubscription.countDocuments({ ...filter, launchNotifiedAt: null }),
  ]);

  return {
    items,
    summary: {
      total,
      pendingLaunchCount,
    },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

async function exportEmailSubscriptionsCsv(query = {}) {
  const filter = {};
  const source = String(query.source || '').trim();
  const launchStatus = String(query.launchStatus || 'all').trim();

  if (source) filter.source = source;
  if (launchStatus === 'pending') filter.launchNotifiedAt = null;
  if (launchStatus === 'notified') filter.launchNotifiedAt = { $ne: null };

  const rows = await EmailSubscription.find(filter)
    .sort({ createdAt: -1 })
    .select('email source launchNotifiedAt createdAt')
    .lean();

  const header = ['email', 'source', 'subscribed_at', 'launch_notified_at'];
  const lines = rows.map((row) => [
    row.email,
    row.source,
    row.createdAt ? DateUtil.toISO(row.createdAt) : '',
    row.launchNotifiedAt ? DateUtil.toISO(row.launchNotifiedAt) : '',
  ]);

  const escapeCsv = (value) => {
    const text = String(value ?? '');
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };

  return [header, ...lines].map((line) => line.map(escapeCsv).join(',')).join('\n');
}

module.exports = {
  listEmailSubscriptions,
  exportEmailSubscriptionsCsv,
};
