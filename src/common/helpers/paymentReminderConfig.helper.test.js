const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getDefaultPaymentReminderConfig,
  normalizePaymentReminderConfig,
  calendarDaysUntilDue,
  resolveReminderSlotsForToday,
  resolveReminderTimezone,
  buildReminderEventKey,
} = require('./paymentReminderConfig.helper');

describe('paymentReminderConfig.helper', () => {
  it('provides product default schedule (5 days before, on due, 1 and 7 days overdue)', () => {
    const config = getDefaultPaymentReminderConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.beforeDueDate.intervals[0].daysBefore, 5);
    assert.equal(config.beforeDueDate.intervals[0].enabled, true);
    assert.equal(config.beforeDueDate.intervals[1].enabled, false);
    assert.equal(config.onDueDate, true);
    assert.equal(config.afterDueDate.intervals[0].daysAfter, 1);
    assert.equal(config.afterDueDate.intervals[1].daysAfter, 7);
  });

  it('normalizes partial HOA settings without breaking defaults', () => {
    const config = normalizePaymentReminderConfig({
      paymentReminders: {
        beforeDueDate: {
          intervals: [{ daysBefore: 3, enabled: true }],
        },
      },
    });
    assert.equal(config.beforeDueDate.intervals.length, 1);
    assert.equal(config.beforeDueDate.intervals[0].daysBefore, 3);
    assert.equal(config.channels.email, true);
    assert.equal(config.afterDueDate.maxOverdueReminders, 10);
  });

  it('computes calendar days until due correctly', () => {
    assert.equal(calendarDaysUntilDue('2026-08-20', '2026-08-25'), 5);
    assert.equal(calendarDaysUntilDue('2026-08-25', '2026-08-25'), 0);
    assert.equal(calendarDaysUntilDue('2026-08-26', '2026-08-25'), -1);
  });

  it('resolves before-due slot when days match configured interval', () => {
    const config = getDefaultPaymentReminderConfig();
    const slots = resolveReminderSlotsForToday(config, 5);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].reminderType, 'before_due');
    assert.equal(slots[0].daysOffset, 5);
  });

  it('respects grace period before overdue reminders', () => {
    const config = getDefaultPaymentReminderConfig();
    const slots = resolveReminderSlotsForToday(config, -2, { gracePeriodDays: 5 });
    assert.equal(slots.length, 0);
  });

  it('fires overdue slot after grace period', () => {
    const config = getDefaultPaymentReminderConfig();
    const slots = resolveReminderSlotsForToday(config, -1, { gracePeriodDays: 0 });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].reminderType, 'overdue');
  });

  it('stops overdue reminders after max count', () => {
    const config = getDefaultPaymentReminderConfig();
    const slots = resolveReminderSlotsForToday(config, -1, {
      gracePeriodDays: 0,
      overdueRemindersSent: config.afterDueDate.maxOverdueReminders,
    });
    assert.equal(slots.length, 0);
  });

  it('builds stable deduplication event keys', () => {
    const key = buildReminderEventKey('before_due', 5, '2026-08-20', 'abc123', 'Owner@Example.com');
    assert.match(key, /^payment_reminder:before_due:5:2026-08-20:abc123:owner@example\.com$/);
  });

  it('returns no slots when reminders are disabled', () => {
    const config = getDefaultPaymentReminderConfig();
    config.enabled = false;
    assert.deepEqual(resolveReminderSlotsForToday(config, 5), []);
    assert.deepEqual(resolveReminderSlotsForToday(config, 0), []);
    assert.deepEqual(resolveReminderSlotsForToday(config, -1, { gracePeriodDays: 0 }), []);
  });

  it('does not fire disabled before-due intervals', () => {
    const config = getDefaultPaymentReminderConfig();
    assert.deepEqual(resolveReminderSlotsForToday(config, 3), []);
    assert.deepEqual(resolveReminderSlotsForToday(config, 1), []);
  });

  it('does not fire before-due when the before-due group is off', () => {
    const config = getDefaultPaymentReminderConfig();
    config.beforeDueDate.enabled = false;
    assert.deepEqual(resolveReminderSlotsForToday(config, 5), []);
  });

  it('fires due-today and respects onDueDate=false', () => {
    const config = getDefaultPaymentReminderConfig();
    const dueToday = resolveReminderSlotsForToday(config, 0);
    assert.equal(dueToday.length, 1);
    assert.equal(dueToday[0].reminderType, 'due_today');
    assert.equal(dueToday[0].templateKey, 'onDueDate');

    config.onDueDate = false;
    assert.deepEqual(resolveReminderSlotsForToday(config, 0), []);
  });

  it('does not fire overdue during grace when respectGracePeriod is on', () => {
    const config = getDefaultPaymentReminderConfig();
    assert.deepEqual(resolveReminderSlotsForToday(config, -1, { gracePeriodDays: 5 }), []);
    assert.deepEqual(resolveReminderSlotsForToday(config, -5, { gracePeriodDays: 5 }), []);
  });

  it('fires overdue during grace when respectGracePeriod is off', () => {
    const config = getDefaultPaymentReminderConfig();
    config.respectGracePeriod = false;
    const slots = resolveReminderSlotsForToday(config, -1, { gracePeriodDays: 5 });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].reminderType, 'overdue');
    assert.equal(slots[0].templateKey, 'overdue');
  });

  it('does not fire overdue between configured interval days', () => {
    const config = getDefaultPaymentReminderConfig();
    const slots = resolveReminderSlotsForToday(config, -3, { gracePeriodDays: 0 });
    assert.deepEqual(slots, []);
  });

  it('fires recurring overdue after the last configured day on the frequency cadence', () => {
    const config = getDefaultPaymentReminderConfig();
    const day14 = resolveReminderSlotsForToday(config, -14, { gracePeriodDays: 0 });
    assert.equal(day14.length, 1);
    assert.equal(day14[0].isRecurringOverdue, true);
    assert.equal(day14[0].daysOffset, -14);

    assert.deepEqual(resolveReminderSlotsForToday(config, -8, { gracePeriodDays: 0 }), []);
    assert.deepEqual(resolveReminderSlotsForToday(config, -13, { gracePeriodDays: 0 }), []);
  });

  it('does not continue overdue reminders when continueOverdueReminders is off', () => {
    const config = getDefaultPaymentReminderConfig();
    config.afterDueDate.continueOverdueReminders = false;
    assert.deepEqual(resolveReminderSlotsForToday(config, -14, { gracePeriodDays: 0 }), []);
    const day7 = resolveReminderSlotsForToday(config, -7, { gracePeriodDays: 0 });
    assert.equal(day7.length, 1);
  });

  it('clamps overdue frequency and max reminder counts', () => {
    const config = normalizePaymentReminderConfig({
      paymentReminders: {
        afterDueDate: {
          overdueFrequencyDays: 99,
          maxOverdueReminders: 0,
        },
      },
    });
    assert.equal(config.afterDueDate.overdueFrequencyDays, 30);
    assert.equal(config.afterDueDate.maxOverdueReminders, 10);
  });

  it('resolveReminderTimezone prefers the property IANA zone over HOA settings', () => {
    const config = {
      timezone: 'Asia/Kolkata',
    };
    assert.equal(
      resolveReminderTimezone(config, 'America/New_York'),
      'America/New_York',
    );
    assert.equal(
      resolveReminderTimezone(config, 'America/Los_Angeles'),
      'America/Los_Angeles',
    );
  });

  it('resolveReminderTimezone falls back to HOA settings then Eastern', () => {
    assert.equal(
      resolveReminderTimezone({ timezone: 'America/Chicago' }, ''),
      'America/Chicago',
    );
    assert.equal(
      resolveReminderTimezone({ timezone: 'Asia/Kolkata' }, null),
      'Asia/Kolkata',
    );
    assert.equal(resolveReminderTimezone({}, null), 'America/New_York');
    assert.equal(resolveReminderTimezone({}, 'Not/A_Zone'), 'America/New_York');
  });

  it('falls back to product default intervals when saved list is empty', () => {
    const config = normalizePaymentReminderConfig({
      paymentReminders: {
        beforeDueDate: { intervals: [] },
        afterDueDate: { intervals: [] },
      },
    });
    assert.equal(config.beforeDueDate.intervals.length, 3);
    assert.equal(config.afterDueDate.intervals.length, 2);
  });
});
