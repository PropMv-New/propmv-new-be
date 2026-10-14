const EmailSubscription = require('../model/emailSubscription.model');

const ALLOWED_SOURCES = new Set(['coming-soon']);

function normalizeSource(source) {
  const normalized = String(source || 'coming-soon').trim().toLowerCase();
  return ALLOWED_SOURCES.has(normalized) ? normalized : 'coming-soon';
}

async function subscribeEmail({ email, source = 'coming-soon' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedSource = normalizeSource(source);

  const existing = await EmailSubscription.findOne({ email: normalizedEmail }).lean();
  if (existing) {
    return { alreadySubscribed: true, subscription: existing };
  }

  try {
    const subscription = await EmailSubscription.create({
      email: normalizedEmail,
      source: normalizedSource,
    });
    return { alreadySubscribed: false, subscription: subscription.toObject() };
  } catch (err) {
    if (err && err.code === 11000) {
      const duplicate = await EmailSubscription.findOne({ email: normalizedEmail }).lean();
      return { alreadySubscribed: true, subscription: duplicate };
    }
    throw err;
  }
}

module.exports = { subscribeEmail };
