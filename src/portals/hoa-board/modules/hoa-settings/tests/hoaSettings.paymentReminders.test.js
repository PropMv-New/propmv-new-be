const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { upsertHoaSettingsSchema } = require('../validators/hoaSettings.validator');
const HOASettings = require('../model/hoaSettings.model');
const HOAMembership = require('../../hoa/model/hoaMembership.model');
const HOA = require('../../hoa/model/hoa.model');
const activityService = require('../../dashboard/service/activity.service');
const hoaNotify = require('../../../../../common/helpers/hoaCommunityNotify.helper');
const { normalizePaymentReminderConfig } = require('../../../../../common/helpers/paymentReminderConfig.helper');

const HOA_ID = '507f1f77bcf86cd799439099';
const ADMIN_ID = '507f1f77bcf86cd799439011';

/** Same shape ManageHOAPage sends via mapPaymentRemindersToApi(DEFAULT_PAYMENT_REMINDERS). */
const UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD = {
  enabled: true,
  channels: { email: true, inApp: true, push: false },
  beforeDueDate: {
    enabled: true,
    intervals: [
      { daysBefore: 5, enabled: true },
      { daysBefore: 3, enabled: false },
      { daysBefore: 1, enabled: false },
    ],
  },
  onDueDate: true,
  afterDueDate: {
    enabled: true,
    intervals: [
      { daysAfter: 1, enabled: true },
      { daysAfter: 7, enabled: true },
    ],
    continueOverdueReminders: true,
    overdueFrequencyDays: 7,
    maxOverdueReminders: 10,
  },
  respectGracePeriod: true,
  templates: {
    beforeDue: { subject: '', body: '' },
    onDueDate: { subject: '', body: '' },
    overdue: { subject: '', body: '' },
  },
};

const stubs = {
  logActivity: async () => {},
  notifyFeeUpdated: () => {},
};

const originals = {
  logActivity: activityService.logActivity,
  notifyFeeUpdated: hoaNotify.notifyHoaFeeUpdatedInAppInBackground,
};

activityService.logActivity = (...args) => stubs.logActivity(...args);
hoaNotify.notifyHoaFeeUpdatedInAppInBackground = (...args) => stubs.notifyFeeUpdated(...args);

const hoaSettingsService = require('../service/hoaSettings.service');

function leanQuery(result) {
  return { lean: async () => result };
}

describe('hoaSettings paymentReminders validator', () => {
  it('accepts the Manage HOA UI default save payload', () => {
    const { error, value } = upsertHoaSettingsSchema.validate({
      paymentReminders: UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD,
    });
    assert.equal(error, undefined);
    assert.equal(value.paymentReminders.enabled, true);
    assert.equal(value.paymentReminders.beforeDueDate.intervals[0].daysBefore, 5);
  });

  it('accepts custom templates and disabled master switch', () => {
    const { error } = upsertHoaSettingsSchema.validate({
      paymentReminders: {
        ...UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD,
        enabled: false,
        templates: {
          beforeDue: { subject: 'Due soon {{invoiceNumber}}', body: 'Please pay.' },
          onDueDate: { subject: '', body: '' },
          overdue: { subject: 'Past due', body: 'Pay now.' },
        },
      },
    });
    assert.equal(error, undefined);
  });

  it('rejects invalid before-due interval offsets', () => {
    const { error } = upsertHoaSettingsSchema.validate({
      paymentReminders: {
        beforeDueDate: {
          intervals: [{ daysBefore: 0, enabled: true }],
        },
      },
    });
    assert.ok(error);
  });

  it('rejects overdue frequency and max outside product limits', () => {
    const tooFrequent = upsertHoaSettingsSchema.validate({
      paymentReminders: { afterDueDate: { overdueFrequencyDays: 31 } },
    });
    assert.ok(tooFrequent.error);

    const tooMany = upsertHoaSettingsSchema.validate({
      paymentReminders: { afterDueDate: { maxOverdueReminders: 53 } },
    });
    assert.ok(tooMany.error);
  });
});

describe('hoaSettings recurringFee amount limits', () => {
  it('accepts recurring fee amounts up to 1000000', () => {
    const atLimit = upsertHoaSettingsSchema.validate({
      recurringFee: { enabled: true, amount: 1000000, frequency: 'monthly', tenure: 1 },
    });
    assert.equal(atLimit.error, undefined);
    assert.equal(atLimit.value.recurringFee.amount, 1000000);
  });

  it('rejects recurring fee amounts above 1000000', () => {
    const overLimit = upsertHoaSettingsSchema.validate({
      recurringFee: { enabled: true, amount: 1000000.01, frequency: 'monthly', tenure: 1 },
    });
    assert.ok(overLimit.error);

    const huge = upsertHoaSettingsSchema.validate({
      recurringFee: { enabled: true, amount: 9999999999, frequency: 'monthly', tenure: 1 },
    });
    assert.ok(huge.error);
  });
});


describe('hoaSettings paymentReminders UI ↔ automation contract', () => {
  it('normalizes the UI save payload into the scheduler config', () => {
    const config = normalizePaymentReminderConfig({
      paymentReminders: UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD,
    });
    assert.equal(config.enabled, true);
    assert.equal(config.channels.push, false);
    assert.equal(
      config.beforeDueDate.intervals.find((row) => row.daysBefore === 5)?.enabled,
      true
    );
    assert.equal(
      config.beforeDueDate.intervals.find((row) => row.daysBefore === 3)?.enabled,
      false
    );
    assert.equal(config.afterDueDate.overdueFrequencyDays, 7);
    assert.equal(config.respectGracePeriod, true);
  });
});

describe('hoaSettings.service upsert paymentReminders', () => {
  let originalMembershipFindOne;
  let originalSettingsFindOne;
  let originalSettingsUpdate;
  let originalHoaFindById;

  beforeEach(() => {
    originalMembershipFindOne = HOAMembership.findOne;
    originalSettingsFindOne = HOASettings.findOne;
    originalSettingsUpdate = HOASettings.findOneAndUpdate;
    originalHoaFindById = HOA.findById;
    stubs.logActivity = async () => {};
    stubs.notifyFeeUpdated = () => {};

    HOA.findById = () => ({
      select: () => leanQuery({ name: 'Sunset Ridge' }),
      lean: async () => ({ name: 'Sunset Ridge' }),
    });
  });

  afterEach(() => {
    HOAMembership.findOne = originalMembershipFindOne;
    HOASettings.findOne = originalSettingsFindOne;
    HOASettings.findOneAndUpdate = originalSettingsUpdate;
    HOA.findById = originalHoaFindById;
  });

  it('persists payment reminder dotted fields for an HOA admin', async () => {
    const captured = {};
    HOAMembership.findOne = () => leanQuery({ role: 'admin', hoaId: HOA_ID, userId: ADMIN_ID });
    HOASettings.findOne = () => leanQuery({
      hoaId: HOA_ID,
      recurringFee: { enabled: true, amount: 250, tenure: 1, frequency: 'monthly' },
      paymentTerm: { dueDay: 1, gracePeriodDays: 5, acceptPartialPayments: true },
      paymentReminders: { enabled: true, channels: { email: true, inApp: true, push: false } },
    });
    HOASettings.findOneAndUpdate = async (_filter, update) => {
      captured.update = update;
      return {
        toObject() {
          return {
            hoaId: HOA_ID,
            recurringFee: { enabled: true, amount: 250, tenure: 1, frequency: 'monthly' },
            paymentTerm: { dueDay: 1, gracePeriodDays: 5, acceptPartialPayments: true },
            paymentReminders: UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD,
          };
        },
      };
    };

    const saved = await hoaSettingsService.upsertSettings(
      ADMIN_ID,
      HOA_ID,
      { hoaId: HOA_ID },
      { paymentReminders: UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD }
    );

    assert.ok(saved);
    assert.equal(captured.update.$set['paymentReminders.enabled'], true);
    assert.equal(captured.update.$set['paymentReminders.channels.email'], true);
    assert.equal(captured.update.$set['paymentReminders.channels.inApp'], true);
    assert.equal(captured.update.$set['paymentReminders.onDueDate'], true);
    assert.equal(captured.update.$set['paymentReminders.respectGracePeriod'], true);
    assert.deepEqual(
      captured.update.$set['paymentReminders.beforeDueDate.intervals'],
      UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD.beforeDueDate.intervals
    );
    assert.equal(captured.update.$set['paymentReminders.afterDueDate.overdueFrequencyDays'], 7);
    assert.equal(captured.update.$set['paymentReminders.templates.beforeDue.subject'], '');
  });

  it('logs payment reminder settings updated when channels change', async () => {
    const descriptions = [];
    HOAMembership.findOne = () => leanQuery({ role: 'admin', hoaId: HOA_ID, userId: ADMIN_ID });
    HOASettings.findOne = () => leanQuery({
      hoaId: HOA_ID,
      recurringFee: { enabled: true, amount: 250, tenure: 1, frequency: 'monthly' },
      paymentTerm: { dueDay: 1, gracePeriodDays: 5, acceptPartialPayments: true },
      paymentReminders: { enabled: true, channels: { email: true, inApp: true, push: false } },
    });
    HOASettings.findOneAndUpdate = async () => ({
      toObject() {
        return {
          hoaId: HOA_ID,
          recurringFee: { enabled: true, amount: 250, tenure: 1, frequency: 'monthly' },
          paymentTerm: { dueDay: 1, gracePeriodDays: 5, acceptPartialPayments: true },
          paymentReminders: {
            ...UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD,
            channels: { email: false, inApp: true, push: false },
          },
        };
      },
    });
    stubs.logActivity = async (payload) => {
      descriptions.push(payload.description);
    };

    await hoaSettingsService.upsertSettings(
      ADMIN_ID,
      HOA_ID,
      { hoaId: HOA_ID },
      {
        paymentReminders: {
          ...UI_DEFAULT_PAYMENT_REMINDERS_PAYLOAD,
          channels: { email: false, inApp: true, push: false },
        },
      }
    );

    assert.ok(descriptions.includes('Payment reminder settings updated.'));
  });

  it('rejects non-admin members from changing reminder settings', async () => {
    HOAMembership.findOne = () => leanQuery({ role: 'member', hoaId: HOA_ID, userId: ADMIN_ID });

    await assert.rejects(
      () => hoaSettingsService.upsertSettings(
        ADMIN_ID,
        HOA_ID,
        { hoaId: HOA_ID },
        { paymentReminders: { enabled: false } }
      ),
      /Only HOA admins can manage these settings/
    );
  });
});

process.on('exit', () => {
  activityService.logActivity = originals.logActivity;
  hoaNotify.notifyHoaFeeUpdatedInAppInBackground = originals.notifyFeeUpdated;
});
