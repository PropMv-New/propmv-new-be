const EmailSubscription = require('../model/emailSubscription.model');
const logger = require('../../../../common/logger');
const { ClockService } = require('../../../../common/date');
const {
  sendLaunchAnnouncementEmail,
  sleep,
} = require('./emailSubscriptionLaunchNotify.service');

async function announceLaunchToSubscribers(options = {}) {
  const source = String(options.source || 'coming-soon').trim();
  const includeAlreadyNotified = !!options.includeAlreadyNotified;
  const dryRun = !!options.dryRun;

  const filter = { source };
  if (!includeAlreadyNotified) {
    filter.launchNotifiedAt = null;
  }

  const subscribers = await EmailSubscription.find(filter)
    .sort({ createdAt: 1 })
    .select('_id email launchNotifiedAt')
    .lean();

  if (dryRun) {
    return {
      dryRun: true,
      total: subscribers.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      failures: [],
    };
  }

  const delayMs = Number(process.env.MARKETING_LAUNCH_EMAIL_DELAY_MS) || 250;
  let sent = 0;
  let failed = 0;
  const failures = [];

  for (const subscriber of subscribers) {
    try {
      await sendLaunchAnnouncementEmail(subscriber.email);
      await EmailSubscription.updateOne(
        { _id: subscriber._id },
        { $set: { launchNotifiedAt: ClockService.now() } }
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      failures.push({
        email: subscriber.email,
        message: err.message || 'Failed to send launch email',
      });
      logger.error('[Marketing] Launch announcement failed:', subscriber.email, err.message);
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    dryRun: false,
    total: subscribers.length,
    sent,
    failed,
    skipped: 0,
    failures: failures.slice(0, 20),
  };
}

module.exports = { announceLaunchToSubscribers };
