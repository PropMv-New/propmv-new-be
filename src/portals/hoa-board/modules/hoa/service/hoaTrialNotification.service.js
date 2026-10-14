'use strict';

const logger = require('../../../../../common/logger');
const HOA = require('../model/hoa.model');
const HOAMembership = require('../model/hoaMembership.model');
const { ClockService } = require('../../../../../common/date');
const {
  SUPPORT_TRIAL_EMAIL,
  TRIAL_STATUS,
  getHoaSubscriptionStatus,
  isLegacyHoa,
} = require('./hoaSubscription.service');

const BOARD_COPY = {
  day7: {
    subject: '7 days remaining in your PropMv HOA free trial',
    text: 'You have 7 days remaining in your PropMv HOA free trial.',
  },
  day3: {
    subject: 'Your PropMv HOA free trial ends in 3 days',
    text: 'Your PropMv HOA free trial ends in 3 days.',
  },
  day1: {
    subject: 'Your PropMv HOA free trial ends tomorrow',
    text: 'Your PropMv HOA free trial ends tomorrow.',
  },
  expired: {
    subject: 'Your PropMv HOA free trial has ended',
    text: 'Your PropMv HOA free trial has ended. Subscribe to continue using PropMv.',
  },
  started: {
    subject: 'Your 14-day PropMv HOA free trial has started',
    text: 'Your 14-day PropMv HOA free trial has started.',
  },
};

const SUPPORT_DAY4 = {
  subject: 'HOA trial expires in 4 days',
  text: 'An HOA free trial expires in 4 days. Please review the account before the subscription access ends.',
};

function reminderKeyForStatus(status) {
  if (!status || status.legacy || status.trialStatus === TRIAL_STATUS.SUBSCRIBED) return null;
  if (status.trialStatus === TRIAL_STATUS.CANCELLED) return null;
  if (status.trialStatus === TRIAL_STATUS.EXPIRED || status.daysRemaining === 0) return 'expired';
  if (status.daysRemaining === 7) return 'day7';
  if (status.daysRemaining === 4) return 'day4Support';
  if (status.daysRemaining === 3) return 'day3';
  if (status.daysRemaining === 1) return 'day1';
  return null;
}

async function loadBoardEmails(hoaId) {
  const rows = await HOAMembership.find({
    hoaId,
    status: 'active',
    email: { $exists: true, $ne: '' },
  }).select('email').lean();
  return [...new Set(rows.map((row) => String(row.email || '').trim().toLowerCase()).filter(Boolean))];
}

async function sendPlain(sendEmail, to, subject, text, hoaName) {
  const html = `<p>${text}</p>${hoaName ? `<p>Community: ${hoaName}</p>` : ''}`;
  await sendEmail({
    to,
    subject,
    text: hoaName ? `${text}\n\nCommunity: ${hoaName}` : text,
    html,
    templateName: 'hoa-trial',
    skipRecipientValidation: true,
    origin: 'system',
  });
}

async function notifyTrialStarted(hoa, deps = {}) {
  if (!hoa?._id || isLegacyHoa(hoa)) return { sent: false };
  if (hoa.trialReminders?.startedAt) return { sent: false, duplicate: true };
  const sendEmail = deps.sendEmail || require('../../../../../common/helpers/emailHelper').sendEmail;
  const emails = deps.emails || await loadBoardEmails(hoa._id);
  const copy = BOARD_COPY.started;
  for (const email of emails) {
    try {
      await sendPlain(sendEmail, email, copy.subject, copy.text, hoa.name);
    } catch (err) {
      logger.warn('[hoaTrial] started email failed', { error: err?.message || err, email });
    }
  }
  await HOA.updateOne(
    { _id: hoa._id },
    { $set: { 'trialReminders.startedAt': ClockService.now() } }
  );
  return { sent: true, recipients: emails.length };
}

/**
 * Daily sweep. Board emails at 7, 3, 1, and expiration.
 * support@propmv.com is notified when 4 days remain.
 */
async function processHoaTrialReminders(hoa, now = ClockService.now(), deps = {}) {
  if (!hoa?._id || isLegacyHoa(hoa)) return { skipped: true };
  const status = getHoaSubscriptionStatus(hoa, now);
  const key = reminderKeyForStatus(status);
  const reminders = hoa.trialReminders || {};

  const patch = {};
  if (status.trialStatus === TRIAL_STATUS.EXPIRED && hoa.trialStatus !== TRIAL_STATUS.EXPIRED) {
    patch.trialStatus = TRIAL_STATUS.EXPIRED;
  }
  if (!key) {
    if (Object.keys(patch).length) await HOA.updateOne({ _id: hoa._id }, { $set: patch });
    return { skipped: true, status: status.trialStatus };
  }
  if (reminders[`${key}At`]) {
    if (Object.keys(patch).length) await HOA.updateOne({ _id: hoa._id }, { $set: patch });
    return { skipped: true, duplicate: key };
  }

  const sendEmail = deps.sendEmail || require('../../../../../common/helpers/emailHelper').sendEmail;
  if (key === 'day4Support') {
    const text = `${SUPPORT_DAY4.text}${hoa.name ? ` Community: ${hoa.name}.` : ''}`;
    try {
      await sendPlain(sendEmail, SUPPORT_TRIAL_EMAIL, SUPPORT_DAY4.subject, text, hoa.name);
    } catch (err) {
      logger.warn('[hoaTrial] support email failed', { error: err?.message || err, hoaId: String(hoa._id) });
      return { sent: false, key };
    }
  } else {
    const copy = BOARD_COPY[key];
    const emails = deps.emails || await loadBoardEmails(hoa._id);
    for (const email of emails) {
      try {
        await sendPlain(sendEmail, email, copy.subject, copy.text, hoa.name);
      } catch (err) {
        logger.warn('[hoaTrial] reminder failed', { error: err?.message || err, email, key });
      }
    }
  }

  patch[`trialReminders.${key}At`] = now;
  await HOA.updateOne({ _id: hoa._id }, { $set: patch });
  return { sent: true, key, trialStatus: patch.trialStatus || status.trialStatus };
}

async function runHoaTrialReminderSweep(now = ClockService.now(), deps = {}) {
  const hoas = await HOA.find({
    isDeleted: { $ne: true },
    trialStartAt: { $exists: true },
    subscriptionStatus: { $ne: 'ACTIVE' },
    trialStatus: { $nin: [TRIAL_STATUS.SUBSCRIBED, TRIAL_STATUS.CANCELLED] },
  }).select('name trialStartAt trialEndAt trialStatus subscriptionStatus trialReminders').lean();

  const results = [];
  for (const hoa of hoas) {
    try {
      results.push({ hoaId: String(hoa._id), ...(await processHoaTrialReminders(hoa, now, deps)) });
    } catch (err) {
      logger.warn('[hoaTrial] sweep failed', { hoaId: String(hoa._id), error: err?.message || err });
      results.push({ hoaId: String(hoa._id), error: err?.message || String(err) });
    }
  }
  return { processed: results.length, results };
}

module.exports = {
  BOARD_COPY,
  SUPPORT_DAY4,
  reminderKeyForStatus,
  notifyTrialStarted,
  processHoaTrialReminders,
  runHoaTrialReminderSweep,
};
