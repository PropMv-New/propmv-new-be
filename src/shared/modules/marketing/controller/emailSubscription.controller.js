const logger = require('../../../../common/logger');
const { success, error } = require('../../../../common/helpers/responseHelper');
const { subscribeEmail } = require('../service/emailSubscription.service');
const {
  notifySubscriptionConfirmationInBackground,
} = require('../service/emailSubscriptionNotify.service');
const {
  listEmailSubscriptions,
  exportEmailSubscriptionsCsv,
} = require('../service/emailSubscriptionAdmin.service');
const { announceLaunchToSubscribers } = require('../service/emailSubscriptionLaunch.service');

async function createEmailSubscription(req, res) {
  try {
    const { email, source } = req.body || {};
    const result = await subscribeEmail({ email, source });

    if (!result.alreadySubscribed) {
      notifySubscriptionConfirmationInBackground(result.subscription.email);
    }

    const message = result.alreadySubscribed
      ? "You're already subscribed. We'll keep you posted."
      : "Thanks for subscribing! Check your inbox for a confirmation email.";

    return success(
      res,
      { alreadySubscribed: result.alreadySubscribed },
      message,
      result.alreadySubscribed ? 200 : 201
    );
  } catch (err) {
    logger.error('[Marketing] createEmailSubscription failed:', err.message);
    return error(res, err.message || 'Failed to save subscription', 500);
  }
}

async function getEmailSubscriptions(req, res) {
  try {
    const result = await listEmailSubscriptions(req.query || {});
    return success(res, result, 'Launch list subscribers fetched');
  } catch (err) {
    logger.error('[Marketing] getEmailSubscriptions failed:', err.message);
    return error(res, err.message || 'Failed to fetch subscribers', 500);
  }
}

async function exportEmailSubscriptions(req, res) {
  try {
    const csv = await exportEmailSubscriptionsCsv(req.query || {});
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="propmv-launch-subscribers.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    logger.error('[Marketing] exportEmailSubscriptions failed:', err.message);
    return error(res, err.message || 'Failed to export subscribers', 500);
  }
}

async function sendLaunchAnnouncement(req, res) {
  try {
    const result = await announceLaunchToSubscribers(req.body || {});
    const message = result.dryRun
      ? `Dry run complete. ${result.total} subscriber(s) would receive the launch email.`
      : `Launch announcement sent to ${result.sent} subscriber(s).`;
    return success(res, result, message);
  } catch (err) {
    logger.error('[Marketing] sendLaunchAnnouncement failed:', err.message);
    return error(res, err.message || 'Failed to send launch announcement', 500);
  }
}

module.exports = {
  createEmailSubscription,
  getEmailSubscriptions,
  exportEmailSubscriptions,
  sendLaunchAnnouncement,
};
