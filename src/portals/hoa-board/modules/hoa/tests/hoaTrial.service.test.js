'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  HOA_TRIAL_DAYS,
  HOA_TRIAL_TIMEZONE,
  buildInitialTrialFields,
  withNewHoaTrial,
  getHoaSubscriptionStatus,
  getHoaTrialDaysRemaining,
  getHoaTrialStatus,
  isHoaTrialActive,
  subscribedPatch,
} = require('../service/hoaSubscription.service');
const { reminderKeyForStatus, SUPPORT_DAY4 } = require('../service/hoaTrialNotification.service');
const { isAllowlisted } = require('../../../../../middleware/hoaTrialAccess');

function hoaFrom(createdAt) {
  return { name: 'Maple HOA', ...buildInitialTrialFields(createdAt) };
}

describe('HOA 14-day trial', () => {
  it('TC-03 starts a 14-day America/New_York trial on HOA creation', () => {
    const createdAt = new Date('2026-09-24T19:00:00.000Z'); // Sep 24, 2026 3:00 PM ET
    const fields = buildInitialTrialFields(createdAt);
    assert.equal(HOA_TRIAL_TIMEZONE, 'America/New_York');
    assert.equal(HOA_TRIAL_DAYS, 14);
    assert.equal(fields.trialStatus, 'TRIAL');
    assert.equal(fields.subscriptionStatus, 'NONE');
    assert.equal(fields.trialStartAt.toISOString(), createdAt.toISOString());
    assert.equal(fields.trialEndAt.toISOString(), '2026-10-08T04:00:00.000Z');
    const status = getHoaSubscriptionStatus(hoaFrom(createdAt), createdAt);
    assert.equal(status.trialStatus, 'TRIAL');
    assert.equal(status.daysRemaining, 14);
    assert.equal(status.accessAllowed, true);
  });

  it('TC-09 uses America/New_York even when the instant is the next calendar day in Asia/Kolkata', () => {
    const createdAt = new Date('2026-09-24T20:30:00.000Z'); // Sep 25 02:00 IST, Sep 24 16:30 ET
    const fields = buildInitialTrialFields(createdAt);
    assert.equal(fields.trialEndAt.toISOString(), '2026-10-08T04:00:00.000Z');
    const status = getHoaSubscriptionStatus(hoaFrom(createdAt), createdAt);
    assert.equal(status.daysRemaining, 14);
    assert.equal(status.timezone, 'America/New_York');
  });

  it('TC-05 and TC-07 share one HOA trial across board members', () => {
    const createdAt = new Date('2026-09-24T19:00:00.000Z');
    const hoa = hoaFrom(createdAt);
    const dayTen = new Date('2026-10-04T16:00:00.000Z'); // Oct 4 ET, 10 calendar days later
    const first = getHoaSubscriptionStatus(hoa, dayTen);
    const second = getHoaSubscriptionStatus(hoa, dayTen);
    assert.equal(first.daysRemaining, 4);
    assert.equal(second.trialEndAt.toISOString(), first.trialEndAt.toISOString());
    assert.equal(getHoaTrialDaysRemaining(hoa, new Date('2026-10-03T16:00:00.000Z')), 5);

    const again = withNewHoaTrial({ ...hoa, name: 'Maple HOA' });
    assert.equal(again.trialStartAt.toISOString(), hoa.trialStartAt.toISOString());
  });

  it('TC-06 expires access when the trial end instant is reached', () => {
    const hoa = hoaFrom(new Date('2026-09-24T19:00:00.000Z'));
    const end = new Date('2026-10-08T04:00:00.000Z');
    assert.equal(isHoaTrialActive(hoa, new Date(end.getTime() - 1000)), true);
    assert.equal(getHoaTrialStatus(hoa, end), 'EXPIRED');
    const status = getHoaSubscriptionStatus(hoa, end);
    assert.equal(status.trialStatus, 'EXPIRED');
    assert.equal(status.daysRemaining, 0);
    assert.equal(status.accessAllowed, false);
    assert.match(status.message, /free trial has ended/i);
  });

  it('TC-08 converts trial to an active subscription', () => {
    const hoa = { ...hoaFrom(new Date('2026-09-24T19:00:00.000Z')), ...subscribedPatch() };
    const status = getHoaSubscriptionStatus(hoa, new Date('2026-09-30T16:00:00.000Z'));
    assert.equal(status.trialStatus, 'SUBSCRIBED');
    assert.equal(status.subscriptionStatus, 'ACTIVE');
    assert.equal(status.trialActive, false);
    assert.equal(status.accessAllowed, true);
    assert.equal(status.daysRemaining, null);
  });

  it('does not start a trial for legacy HOAs', () => {
    const status = getHoaSubscriptionStatus({ name: 'Existing', createdAt: new Date('2020-01-01') });
    assert.equal(status.legacy, true);
    assert.equal(status.accessAllowed, true);
    assert.equal(status.trialStatus, null);
  });

  it('notifies support when 4 days remain and board members on the other milestones', () => {
    const createdAt = new Date('2026-09-24T19:00:00.000Z');
    const hoa = hoaFrom(createdAt);
    const at = (iso) => getHoaSubscriptionStatus(hoa, new Date(iso));
    assert.equal(reminderKeyForStatus(at('2026-10-01T16:00:00.000Z')), 'day7');
    assert.equal(reminderKeyForStatus(at('2026-10-04T16:00:00.000Z')), 'day4Support');
    assert.equal(reminderKeyForStatus(at('2026-10-05T16:00:00.000Z')), 'day3');
    assert.equal(reminderKeyForStatus(at('2026-10-07T16:00:00.000Z')), 'day1');
    assert.equal(reminderKeyForStatus(at('2026-10-08T04:00:00.000Z')), 'expired');
    assert.match(SUPPORT_DAY4.text, /4 days/);
  });

  it('keeps subscription reads available after the trial expires', () => {
    assert.equal(isAllowlisted({ method: 'GET', baseUrl: '/api/v1/hoa/board-members', path: '/my-hoas' }), true);
    assert.equal(isAllowlisted({ method: 'POST', baseUrl: '/api/v1/hoa/board-members', path: '/hoa123/subscribe' }), true);
    assert.equal(isAllowlisted({ method: 'GET', baseUrl: '/api/v1/hoa/property', path: '/' }), false);
  });
});
