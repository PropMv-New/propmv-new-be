const DemoRequest = require('../model/demoRequest.model');

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** Persist a demo request. The lead is the row; email is only a notification. */
async function createDemoRequest(payload) {
  return DemoRequest.create({
    name: clean(payload.name),
    email: clean(payload.email).toLowerCase(),
    phone: clean(payload.phone),
    role: clean(payload.role),
    propertyCount: clean(payload.propertyCount),
    preferredDate: clean(payload.preferredDate),
    preferredTime: clean(payload.preferredTime),
    message: clean(payload.message),
    source: clean(payload.source) || 'website',
  });
}

async function markNotified(id) {
  await DemoRequest.updateOne({ _id: id }, { notifiedAt: new Date() });
}

async function listDemoRequests({ page = 1, limit = 25, status = 'all', search = '' } = {}) {
  const query = {};
  if (status && status !== 'all') query.status = status;
  if (search) {
    // Regex-escape without embedding backslashes in a character class, which
    // does not survive shell heredocs intact.
    const SPECIAL = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', String.fromCharCode(92)]);
    const escaped = String(search)
      .split('')
      .map((c) => (SPECIAL.has(c) ? String.fromCharCode(92) + c : c))
      .join('');
    const rx = new RegExp(escaped, 'i');
    query.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    DemoRequest.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    DemoRequest.countDocuments(query),
  ]);

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

module.exports = { createDemoRequest, markNotified, listDemoRequests };
