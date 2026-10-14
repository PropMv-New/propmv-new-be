'use strict';

const { TIMEZONE } = require('../date');

/** Default reminder schedule per product requirements. */
const DEFAULT_BEFORE_DUE_INTERVALS = [
  { daysBefore: 5, enabled: true },
  { daysBefore: 3, enabled: false },
  { daysBefore: 1, enabled: false },
];

const DEFAULT_AFTER_DUE_INTERVALS = [
  { daysAfter: 1, enabled: true },
  { daysAfter: 7, enabled: true },
];

function normalizeIntervalList(list, key, fallback) {
  if (!Array.isArray(list) || list.length === 0) {
    return fallback.map((row) => ({ ...row }));
  }
  return list
    .map((row) => {
      const offset = Number(row?.[key]);
      if (!Number.isFinite(offset) || offset < 1) return null;
      return {
        [key]: Math.floor(offset),
        enabled: row.enabled !== false,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a[key] - b[key]);
}

function getDefaultPaymentReminderConfig() {
  return {
    enabled: true,
    timezone: null,
    channels: {
      email: true,
      inApp: true,
      push: false,
    },
    beforeDueDate: {
      enabled: true,
      intervals: DEFAULT_BEFORE_DUE_INTERVALS.map((row) => ({ ...row })),
    },
    onDueDate: true,
    afterDueDate: {
      enabled: true,
      intervals: DEFAULT_AFTER_DUE_INTERVALS.map((row) => ({ ...row })),
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
}

function normalizePaymentReminderConfig(hoaSettingsDoc = {}) {
  const defaults = getDefaultPaymentReminderConfig();
  const raw = hoaSettingsDoc?.paymentReminders || {};

  return {
    enabled: raw.enabled !== false,
    timezone: raw.timezone || defaults.timezone,
    channels: {
      email: raw.channels?.email !== false,
      inApp: raw.channels?.inApp !== false,
      push: raw.channels?.push === true,
    },
    beforeDueDate: {
      enabled: raw.beforeDueDate?.enabled !== false,
      intervals: normalizeIntervalList(
        raw.beforeDueDate?.intervals,
        'daysBefore',
        defaults.beforeDueDate.intervals
      ),
    },
    onDueDate: raw.onDueDate !== false,
    afterDueDate: {
      enabled: raw.afterDueDate?.enabled !== false,
      intervals: normalizeIntervalList(
        raw.afterDueDate?.intervals,
        'daysAfter',
        defaults.afterDueDate.intervals
      ),
      continueOverdueReminders: raw.afterDueDate?.continueOverdueReminders !== false,
      overdueFrequencyDays: Math.max(
        1,
        Math.min(30, Number(raw.afterDueDate?.overdueFrequencyDays) || defaults.afterDueDate.overdueFrequencyDays)
      ),
      maxOverdueReminders: Math.max(
        1,
        Math.min(52, Number(raw.afterDueDate?.maxOverdueReminders) || defaults.afterDueDate.maxOverdueReminders)
      ),
    },
    respectGracePeriod: raw.respectGracePeriod !== false,
    templates: {
      beforeDue: {
        subject: String(raw.templates?.beforeDue?.subject || '').trim(),
        body: String(raw.templates?.beforeDue?.body || '').trim(),
      },
      onDueDate: {
        subject: String(raw.templates?.onDueDate?.subject || '').trim(),
        body: String(raw.templates?.onDueDate?.body || '').trim(),
      },
      overdue: {
        subject: String(raw.templates?.overdue?.subject || '').trim(),
        body: String(raw.templates?.overdue?.body || '').trim(),
      },
    },
  };
}

function resolveReminderTimezone(config, propertyTimezone) {
  const fromProperty = typeof propertyTimezone === 'string' ? propertyTimezone.trim() : '';
  if (fromProperty) {
    const { resolveBillingTimezone } = require('./billingTimezone.constants');
    return resolveBillingTimezone(fromProperty);
  }
  const tz = config?.timezone;
  if (typeof tz === 'string' && tz.trim()) {
    const { resolveBillingTimezone } = require('./billingTimezone.constants');
    return resolveBillingTimezone(tz);
  }
  return TIMEZONE.BUSINESS;
}

/**
 * Calendar-day difference: dueDateKey minus todayKey (positive = future due date).
 */
function calendarDaysUntilDue(todayKey, dueDateKey) {
  if (!todayKey || !dueDateKey) return null;
  const { parseDateOnlyToNoonUtc } = require('./hoaBillingDates');
  const todayMs = parseDateOnlyToNoonUtc(todayKey)?.getTime();
  const dueMs = parseDateOnlyToNoonUtc(dueDateKey)?.getTime();
  if (todayMs == null || dueMs == null) return null;
  return Math.round((dueMs - todayMs) / (1000 * 60 * 60 * 24));
}

/**
 * Determine which automated reminder slots should fire today for an invoice.
 * Returns array of { reminderType, daysOffset, templateKey }.
 */
function resolveReminderSlotsForToday(config, daysUntilDue, { gracePeriodDays = 0, overdueRemindersSent = 0 } = {}) {
  if (!config?.enabled || daysUntilDue == null) return [];

  const slots = [];

  if (daysUntilDue > 0 && config.beforeDueDate?.enabled) {
    for (const interval of config.beforeDueDate.intervals || []) {
      if (interval.enabled && interval.daysBefore === daysUntilDue) {
        slots.push({
          reminderType: 'before_due',
          daysOffset: interval.daysBefore,
          templateKey: 'beforeDue',
        });
      }
    }
    return slots;
  }

  if (daysUntilDue === 0 && config.onDueDate) {
    slots.push({
      reminderType: 'due_today',
      daysOffset: 0,
      templateKey: 'onDueDate',
    });
    return slots;
  }

  if (daysUntilDue >= 0 || !config.afterDueDate?.enabled) return slots;

  const daysOverdue = -daysUntilDue;
  if (config.respectGracePeriod && daysOverdue <= Math.max(0, Number(gracePeriodDays) || 0)) {
    return slots;
  }

  if (overdueRemindersSent >= (config.afterDueDate.maxOverdueReminders || 10)) {
    return slots;
  }

  const enabledAfter = (config.afterDueDate.intervals || []).filter((row) => row.enabled);
  const exactMatch = enabledAfter.find((row) => row.daysAfter === daysOverdue);
  if (exactMatch) {
    slots.push({
      reminderType: 'overdue',
      daysOffset: -exactMatch.daysAfter,
      templateKey: 'overdue',
    });
    return slots;
  }

  if (!config.afterDueDate.continueOverdueReminders) return slots;

  const lastConfiguredDay = enabledAfter.reduce(
    (max, row) => Math.max(max, row.daysAfter),
    0
  );
  if (daysOverdue <= lastConfiguredDay) return slots;

  const frequency = config.afterDueDate.overdueFrequencyDays || 7;
  const daysSinceLastConfigured = daysOverdue - lastConfiguredDay;
  if (daysSinceLastConfigured > 0 && daysSinceLastConfigured % frequency === 0) {
    slots.push({
      reminderType: 'overdue',
      daysOffset: -daysOverdue,
      templateKey: 'overdue',
      isRecurringOverdue: true,
    });
  }

  return slots;
}

function buildReminderEventKey(reminderType, daysOffset, dateKey, invoiceId, recipientEmail) {
  const offsetPart = daysOffset == null ? '0' : String(daysOffset);
  return ['payment_reminder', reminderType, offsetPart, dateKey, String(invoiceId), recipientEmail]
    .map((p) => String(p || '').trim().toLowerCase())
    .filter(Boolean)
    .join(':');
}

module.exports = {
  DEFAULT_BEFORE_DUE_INTERVALS,
  DEFAULT_AFTER_DUE_INTERVALS,
  getDefaultPaymentReminderConfig,
  normalizePaymentReminderConfig,
  resolveReminderTimezone,
  calendarDaysUntilDue,
  resolveReminderSlotsForToday,
  buildReminderEventKey,
};
