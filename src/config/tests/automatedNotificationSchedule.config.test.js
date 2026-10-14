const { describe, it, beforeEach, afterEach } = require('node:test');

const assert = require('node:assert/strict');



describe('dailySchedule.config', () => {

  const originalEnv = { ...process.env };



  afterEach(() => {

    process.env = { ...originalEnv };

    delete require.cache[require.resolve('../../config/dailySchedule.config')];

  });



  it('defaults to 00:00 America/New_York from CRON_SCHEDULE=0 0 * * *', () => {

    delete process.env.CRON_SCHEDULE;

    delete process.env.CRON_TIMEZONE;

    delete process.env.DAILY_SCHEDULE_TIME;

    delete process.env.AUTOMATED_NOTIFICATION_TIME;

    delete process.env.DAILY_SCHEDULE_TIMEZONE;

    delete process.env.AUTOMATED_NOTIFICATION_TIMEZONE;



    const { dailySchedule } = require('../../config/dailySchedule.config');

    assert.equal(dailySchedule.hour, 0);

    assert.equal(dailySchedule.minute, 0);

    assert.equal(dailySchedule.timezone, 'America/New_York');

    assert.equal(dailySchedule.cronExpression, '0 0 * * *');

    assert.match(dailySchedule.label, /00:00/);

  });



  it('parses CRON_SCHEDULE and CRON_TIMEZONE from environment', () => {

    process.env.CRON_SCHEDULE = '30 4 * * *';

    process.env.CRON_TIMEZONE = 'America/Chicago';



    const { dailySchedule } = require('../../config/dailySchedule.config');

    assert.equal(dailySchedule.hour, 4);

    assert.equal(dailySchedule.minute, 30);

    assert.equal(dailySchedule.timezone, 'America/Chicago');

  });

});



describe('scheduleParse.util', () => {

  const { parseDailyCronExpression, parseTimeOfDay } = require('../../common/schedulers/scheduleParse.util');



  it('parses daily cron expressions', () => {

    assert.deepEqual(parseDailyCronExpression('0 0 * * *'), { hour: 0, minute: 0 });

    assert.deepEqual(parseDailyCronExpression('15 8 * * *'), { hour: 8, minute: 15 });

    assert.equal(parseDailyCronExpression('0 0 * * 1'), null);

  });



  it('parses HH:MM times', () => {

    assert.deepEqual(parseTimeOfDay('00:00'), { hour: 0, minute: 0 });

    assert.deepEqual(parseTimeOfDay('8:30'), { hour: 8, minute: 30 });

    assert.equal(parseTimeOfDay('invalid'), null);

  });

});



describe('automatedNotificationSchedule.config', () => {

  const originalEnv = { ...process.env };



  afterEach(() => {

    process.env = { ...originalEnv };

    delete require.cache[require.resolve('../../config/dailySchedule.config')];

    delete require.cache[require.resolve('../../config/automatedNotificationSchedule.config')];

  });



  it('parses HH:MM notification times from environment variables', () => {

    process.env.CRON_SCHEDULE = '0 0 * * *';

    process.env.CRON_TIMEZONE = 'America/New_York';

    process.env.INVOICE_NOTIFICATION_TIME = '08:30';

    process.env.OVERDUE_NOTIFICATION_TIME = '09:15';

    process.env.FUTURE_INVOICE_NOTIFICATION_TIME = '07:45';

    process.env.MAINTENANCE_NOTIFICATION_TIME = '10:00';

    process.env.LATE_FEE_NOTIFICATION_TIME = '08:15';

    process.env.NOTE_REMINDER_NOTIFICATION_TIME = '08:45';



    const { automatedNotificationSchedule } = require('../../config/automatedNotificationSchedule.config');

    assert.equal(automatedNotificationSchedule.timezone, 'America/New_York');

    assert.deepEqual(automatedNotificationSchedule.invoiceDue, {

      hour: 8,

      minute: 30,

      enabled: true,

      startupDelayMs: 90_000,

      label: '08:30 America/New_York',

    });

    assert.deepEqual(automatedNotificationSchedule.invoiceOverdue, {

      hour: 9,

      minute: 15,

      enabled: true,

      startupDelayMs: 90_000,

      label: '09:15 America/New_York',

    });

    assert.equal(automatedNotificationSchedule.invoiceRemindersShareSchedule, false);

    assert.equal(automatedNotificationSchedule.futureInvoice.hour, 7);

    assert.equal(automatedNotificationSchedule.futureInvoice.minute, 45);

    assert.equal(automatedNotificationSchedule.maintenance.hour, 10);

    assert.equal(automatedNotificationSchedule.lateFee.hour, 8);

    assert.equal(automatedNotificationSchedule.lateFee.minute, 15);

    assert.equal(automatedNotificationSchedule.noteReminder.hour, 8);

    assert.equal(automatedNotificationSchedule.noteReminder.minute, 45);

  });



  it('uses staggered defaults when per-type overrides are not set', () => {

    process.env.CRON_TIMEZONE = 'UTC';

    delete process.env.INVOICE_NOTIFICATION_TIME;

    delete process.env.OVERDUE_NOTIFICATION_TIME;

    delete process.env.FUTURE_INVOICE_NOTIFICATION_TIME;

    delete process.env.MAINTENANCE_NOTIFICATION_TIME;

    delete process.env.LATE_FEE_NOTIFICATION_TIME;

    delete process.env.NOTE_REMINDER_NOTIFICATION_TIME;

    delete process.env.HOA_TRIAL_NOTIFICATION_TIME;

    delete process.env.OWNERSHIP_TRANSFER_SCHEDULE_TIME;

    delete process.env.HOA_INVOICE_REMINDER_RUN_HOUR_ET;

    delete process.env.HOA_INVOICE_EXTENSION_RUN_HOUR_ET;



    const { automatedNotificationSchedule } = require('../../config/automatedNotificationSchedule.config');

    assert.equal(automatedNotificationSchedule.ownershipTransfer.hour, 0);

    assert.equal(automatedNotificationSchedule.ownershipTransfer.minute, 0);

    assert.equal(automatedNotificationSchedule.futureInvoice.hour, 0);

    assert.equal(automatedNotificationSchedule.futureInvoice.minute, 15);

    assert.equal(automatedNotificationSchedule.invoiceDue.hour, 0);

    assert.equal(automatedNotificationSchedule.invoiceDue.minute, 30);

    assert.equal(automatedNotificationSchedule.invoiceOverdue.hour, 0);

    assert.equal(automatedNotificationSchedule.invoiceOverdue.minute, 45);

    assert.equal(automatedNotificationSchedule.invoiceRemindersShareSchedule, false);

    assert.equal(automatedNotificationSchedule.noteReminder.hour, 1);

    assert.equal(automatedNotificationSchedule.noteReminder.minute, 0);

    assert.equal(automatedNotificationSchedule.maintenance.hour, 1);

    assert.equal(automatedNotificationSchedule.maintenance.minute, 15);

    assert.equal(automatedNotificationSchedule.lateFee.hour, 1);

    assert.equal(automatedNotificationSchedule.lateFee.minute, 30);

    assert.equal(automatedNotificationSchedule.hoaTrial.hour, 1);

    assert.equal(automatedNotificationSchedule.hoaTrial.minute, 45);

    assert.equal(automatedNotificationSchedule.timezone, 'UTC');

  });

});



describe('payment reminder phase filtering', () => {

  it('filters reminder slots by due vs overdue phase', () => {

    const service = require('../../common/helpers/paymentReminderAutomation.service');

    const slots = [

      { reminderType: 'before_due', daysOffset: 5 },

      { reminderType: 'due_today', daysOffset: 0 },

      { reminderType: 'overdue', daysOffset: -1 },

    ];



    assert.equal(service.filterReminderSlotsByPhase(slots, 'due').length, 2);

    assert.equal(service.filterReminderSlotsByPhase(slots, 'overdue').length, 1);

    assert.equal(service.filterReminderSlotsByPhase(slots, 'all').length, 3);

  });

});

