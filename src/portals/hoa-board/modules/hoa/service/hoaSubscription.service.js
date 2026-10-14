'use strict';

const { ClockService, DateUtil, TIMEZONE, MS_PER_DAY } = require('../../../../../common/date');

const HOA_TRIAL_DAYS = 14;
const HOA_TRIAL_TIMEZONE = TIMEZONE.BUSINESS;
const SUPPORT_TRIAL_EMAIL = 'support@propmv.com';

const TRIAL_STATUS = Object.freeze({
  TRIAL: 'TRIAL',
  EXPIRED: 'EXPIRED',
  SUBSCRIBED: 'SUBSCRIBED',
  CANCELLED: 'CANCELLED',
});

const SUBSCRIPTION_STATUS = Object.freeze({
  NONE: 'NONE',
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED',
});

function calendarDaysBetween(laterYmd, earlierYmd) {
  const later = DateUtil.parseDateOnlyToNoonUtc(laterYmd);
  const earlier = DateUtil.parseDateOnlyToNoonUtc(earlierYmd);
  if (!later || !earlier) return null;
  return Math.round((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

/**
 * Trial window is calendar days in America/New_York.
 * Created on Sep 24 ET ends at the start of Oct 8 ET (start date + 14).
 */
function buildInitialTrialFields(createdAt = ClockService.now()) {
  const startAt = createdAt instanceof Date ? new Date(createdAt.getTime()) : new Date(createdAt);
  const startKey = DateUtil.getDateKeyInTimeZone(startAt, HOA_TRIAL_TIMEZONE);
  const endKey = DateUtil.shiftYmdDays(startKey, HOA_TRIAL_DAYS, HOA_TRIAL_TIMEZONE);
  const trialEndAt = DateUtil.calendarDateTimeInTimezoneToUtc(endKey, 0, 0, 0, HOA_TRIAL_TIMEZONE);
  return {
    trialStartAt: startAt,
    trialEndAt,
    trialStatus: TRIAL_STATUS.TRIAL,
    subscriptionStatus: SUBSCRIPTION_STATUS.NONE,
    trialReminders: {},
  };
}

function withNewHoaTrial(payload, createdAt = ClockService.now()) {
  const base = payload && typeof payload === 'object' ? { ...payload } : {};
  if (base.trialStartAt) return base;
  return { ...base, ...buildInitialTrialFields(createdAt) };
}

function isLegacyHoa(hoa) {
  if (!hoa) return true;
  return !hoa.trialStartAt && !hoa.trialStatus;
}

function isSubscribed(hoa) {
  if (!hoa) return false;
  return hoa.subscriptionStatus === SUBSCRIPTION_STATUS.ACTIVE
    || hoa.trialStatus === TRIAL_STATUS.SUBSCRIBED;
}

function isCancelled(hoa) {
  if (!hoa) return false;
  return hoa.trialStatus === TRIAL_STATUS.CANCELLED
    || hoa.subscriptionStatus === SUBSCRIPTION_STATUS.CANCELLED;
}

function getHoaTrialDaysRemaining(hoa, now = ClockService.now()) {
  if (!hoa?.trialEndAt || isLegacyHoa(hoa) || isSubscribed(hoa)) return null;
  const endKey = DateUtil.getDateKeyInTimeZone(hoa.trialEndAt, HOA_TRIAL_TIMEZONE);
  const todayKey = DateUtil.getDateKeyInTimeZone(now, HOA_TRIAL_TIMEZONE);
  if (!endKey || !todayKey) return null;
  const remaining = calendarDaysBetween(endKey, todayKey);
  if (remaining == null) return null;
  return Math.max(0, remaining);
}

function isHoaTrialActive(hoa, now = ClockService.now()) {
  if (!hoa || isLegacyHoa(hoa) || isSubscribed(hoa) || isCancelled(hoa)) return false;
  if (!hoa.trialEndAt) return false;
  const end = hoa.trialEndAt instanceof Date ? hoa.trialEndAt : new Date(hoa.trialEndAt);
  return now.getTime() < end.getTime();
}

function getHoaTrialStatus(hoa, now = ClockService.now()) {
  if (!hoa || isLegacyHoa(hoa)) return null;
  if (isCancelled(hoa) && hoa.trialStatus === TRIAL_STATUS.CANCELLED) return TRIAL_STATUS.CANCELLED;
  if (isSubscribed(hoa)) return TRIAL_STATUS.SUBSCRIBED;
  if (isHoaTrialActive(hoa, now)) return TRIAL_STATUS.TRIAL;
  return TRIAL_STATUS.EXPIRED;
}

function trialMessage(status, daysRemaining) {
  if (status === TRIAL_STATUS.SUBSCRIBED) return null;
  if (status === TRIAL_STATUS.CANCELLED) {
    return 'This HOA subscription is cancelled. Please subscribe to continue using PropMv.';
  }
  if (status === TRIAL_STATUS.EXPIRED || daysRemaining === 0) {
    return 'Your free trial has ended. Please subscribe to continue using PropMv.';
  }
  if (daysRemaining === 1) return 'Your free trial ends tomorrow.';
  if (daysRemaining != null && daysRemaining <= 3) {
    return `Your free trial ends in ${daysRemaining} days.`;
  }
  return null;
}

function getHoaSubscriptionStatus(hoa, now = ClockService.now()) {
  if (!hoa || isLegacyHoa(hoa)) {
    return {
      legacy: true,
      trialStatus: null,
      subscriptionStatus: hoa?.subscriptionStatus || null,
      trialStartAt: hoa?.trialStartAt || null,
      trialEndAt: hoa?.trialEndAt || null,
      daysRemaining: null,
      trialActive: false,
      accessAllowed: !isCancelled(hoa),
      timezone: HOA_TRIAL_TIMEZONE,
      message: null,
    };
  }

  const trialStatus = getHoaTrialStatus(hoa, now);
  const daysRemaining = trialStatus === TRIAL_STATUS.TRIAL
    ? getHoaTrialDaysRemaining(hoa, now)
    : (trialStatus === TRIAL_STATUS.EXPIRED ? 0 : null);
  const subscriptionStatus = isSubscribed(hoa)
    ? SUBSCRIPTION_STATUS.ACTIVE
    : (hoa.subscriptionStatus || SUBSCRIPTION_STATUS.NONE);
  const accessAllowed = trialStatus === TRIAL_STATUS.TRIAL || trialStatus === TRIAL_STATUS.SUBSCRIBED;

  return {
    legacy: false,
    trialStatus,
    subscriptionStatus,
    trialStartAt: hoa.trialStartAt || null,
    trialEndAt: hoa.trialEndAt || null,
    daysRemaining,
    trialActive: trialStatus === TRIAL_STATUS.TRIAL,
    accessAllowed,
    timezone: HOA_TRIAL_TIMEZONE,
    message: trialMessage(trialStatus, daysRemaining),
  };
}

function presentSubscription(hoa, now = ClockService.now()) {
  const status = getHoaSubscriptionStatus(hoa, now);
  return {
    trialStatus: status.trialStatus,
    subscriptionStatus: status.subscriptionStatus,
    trialStartAt: status.trialStartAt,
    trialEndAt: status.trialEndAt,
    daysRemaining: status.daysRemaining,
    trialActive: status.trialActive,
    accessAllowed: status.accessAllowed,
    legacy: status.legacy,
    timezone: status.timezone,
    message: status.message,
  };
}

function subscribedPatch() {
  return {
    trialStatus: TRIAL_STATUS.SUBSCRIBED,
    subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
  };
}

module.exports = {
  HOA_TRIAL_DAYS,
  HOA_TRIAL_TIMEZONE,
  SUPPORT_TRIAL_EMAIL,
  TRIAL_STATUS,
  SUBSCRIPTION_STATUS,
  buildInitialTrialFields,
  withNewHoaTrial,
  isLegacyHoa,
  getHoaSubscriptionStatus,
  getHoaTrialStatus,
  getHoaTrialDaysRemaining,
  isHoaTrialActive,
  presentSubscription,
  subscribedPatch,
  calendarDaysBetween,
};
