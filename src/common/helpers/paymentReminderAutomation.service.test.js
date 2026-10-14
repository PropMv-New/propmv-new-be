const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Invoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const HOASettings = require('../../portals/hoa-board/modules/hoa-settings/model/hoaSettings.model');
const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const EmailDeliveryLog = require('../models/emailDeliveryLog.model');
const transactionalEmail = require('./transactionalEmail.service');
const notifications = require('../notifications');
const invoiceEmailHelper = require('./invoiceNotificationEmailHelper');
const { getDefaultPaymentReminderConfig } = require('./paymentReminderConfig.helper');

const HOA_ID = '507f1f77bcf86cd799439099';
const INVOICE_ID = '507f1f77bcf86cd799439022';

const stubs = {
  sendTransactionalEmail: async () => ({ sent: true }),
  wasAlreadySent: async () => false,
  notify: async () => {},
  resolvePayers: async () => ([
    { _id: '507f1f77bcf86cd799439033', email: 'owner@example.com', firstName: 'Pat', lastName: 'Owner' },
  ]),
  resolveBranding: async () => ({ communityName: 'Sunset Ridge' }),
};

const originals = {
  sendTransactionalEmail: transactionalEmail.sendTransactionalEmail,
  wasAlreadySent: transactionalEmail.wasAlreadySent,
  notify: notifications.notify,
  resolvePayers: invoiceEmailHelper.resolveInvoicePayerUsers,
  resolveBranding: invoiceEmailHelper.resolveInvoiceEmailBranding,
};

transactionalEmail.sendTransactionalEmail = (...args) => stubs.sendTransactionalEmail(...args);
transactionalEmail.wasAlreadySent = (...args) => stubs.wasAlreadySent(...args);
notifications.notify = (...args) => stubs.notify(...args);
invoiceEmailHelper.resolveInvoicePayerUsers = (...args) => stubs.resolvePayers(...args);
invoiceEmailHelper.resolveInvoiceEmailBranding = (...args) => stubs.resolveBranding(...args);

const {
  processInvoiceAutomatedReminders,
  processAutomatedPaymentReminders,
  filterReminderSlotsByPhase,
  invoiceMatchesBillingTimezones,
  UNPAID_INVOICE_MATCH,
} = require('./paymentReminderAutomation.service');

function unpaidInvoice(overrides = {}) {
  return {
    _id: INVOICE_ID,
    invoiceId: 'INV-1001',
    hoaId: HOA_ID,
    propertyName: 'Sunset Ridge',
    unit: '4B',
    balanceDue: 250,
    dueDate: new Date('2026-08-25T12:00:00.000Z'),
    status: 'Pending',
    tenants: ['507f1f77bcf86cd799439033'],
    createdBy: '507f1f77bcf86cd799439011',
    ...overrides,
  };
}

describe('paymentReminderAutomation.service', () => {
  let modelOriginals;

  beforeEach(() => {
    modelOriginals = {
      invoiceFindById: Invoice.findById,
      invoiceUpdate: Invoice.findByIdAndUpdate,
      invoiceAggregate: Invoice.aggregate,
      settingsFind: HOASettings.find,
      propertyFind: Property.find,
      countDocuments: EmailDeliveryLog.countDocuments,
      createLog: EmailDeliveryLog.create,
    };

    stubs.sendTransactionalEmail = async () => ({ sent: true });
    stubs.wasAlreadySent = async () => false;
    stubs.notify = async () => {};
    stubs.resolvePayers = async () => ([
      { _id: '507f1f77bcf86cd799439033', email: 'owner@example.com', firstName: 'Pat', lastName: 'Owner' },
    ]);
    stubs.resolveBranding = async () => ({ communityName: 'Sunset Ridge' });

    Invoice.findById = () => ({
      select: () => ({ lean: async () => ({ reminderHistory: [] }) }),
      lean: async () => ({ reminderHistory: [] }),
    });
    Invoice.findByIdAndUpdate = async () => ({});
    Property.find = () => ({
      select: () => ({ lean: async () => [] }),
    });
    EmailDeliveryLog.countDocuments = async () => 0;
    EmailDeliveryLog.create = async () => ({});
  });

  afterEach(() => {
    Invoice.findById = modelOriginals.invoiceFindById;
    Invoice.findByIdAndUpdate = modelOriginals.invoiceUpdate;
    Invoice.aggregate = modelOriginals.invoiceAggregate;
    HOASettings.find = modelOriginals.settingsFind;
    Property.find = modelOriginals.propertyFind;
    EmailDeliveryLog.countDocuments = modelOriginals.countDocuments;
    EmailDeliveryLog.create = modelOriginals.createLog;
  });

  it('keeps unpaid invoice match aligned with sendable statuses', () => {
    assert.deepEqual(UNPAID_INVOICE_MATCH.status.$in, [
      'Pending',
      'Partially Paid',
      'Overdue',
      'Processing',
    ]);
    assert.equal(UNPAID_INVOICE_MATCH.balanceDue.$gt, 0);
  });

  it('sends email and in-app for a 5-days-before slot', async () => {
    const emailCalls = [];
    const notifyCalls = [];
    stubs.sendTransactionalEmail = async (payload) => {
      emailCalls.push(payload);
      return { sent: true };
    };
    stubs.notify = async (...args) => {
      notifyCalls.push(args);
    };

    const result = await processInvoiceAutomatedReminders(
      unpaidInvoice(),
      getDefaultPaymentReminderConfig(),
      new Date('2026-08-20T16:00:00.000Z'),
      { gracePeriodDays: 0 }
    );

    assert.equal(result.slots, 1);
    assert.equal(result.sent, 1);
    assert.equal(emailCalls.length, 1);
    assert.equal(emailCalls[0].type, 'invoice-due-today');
    assert.equal(emailCalls[0].toEmail, 'owner@example.com');
    assert.match(emailCalls[0].eventKey, /payment_reminder:before_due:5:/);
    assert.equal(notifyCalls.length, 1);
  });

  it('uses a custom before-due subject template', async () => {
    const emailCalls = [];
    stubs.sendTransactionalEmail = async (payload) => {
      emailCalls.push(payload);
      return { sent: true };
    };

    const config = getDefaultPaymentReminderConfig();
    config.templates.beforeDue.subject = 'Heads up {{invoiceNumber}}';

    await processInvoiceAutomatedReminders(
      unpaidInvoice(),
      config,
      new Date('2026-08-20T16:00:00.000Z'),
      { gracePeriodDays: 0 }
    );

    assert.match(String(emailCalls[0]?.options?.subject || ''), /Heads up INV-1001/);
  });

  it('skips send when the event was already delivered', async () => {
    stubs.wasAlreadySent = async () => true;
    let emailed = 0;
    stubs.sendTransactionalEmail = async () => {
      emailed += 1;
      return { sent: true };
    };

    const result = await processInvoiceAutomatedReminders(
      unpaidInvoice(),
      getDefaultPaymentReminderConfig(),
      new Date('2026-08-20T16:00:00.000Z'),
      { gracePeriodDays: 0 }
    );

    assert.equal(result.slots, 1);
    assert.equal(result.sent, 0);
    assert.equal(emailed, 0);
  });

  it('does not send when the invoice has no payer emails', async () => {
    stubs.resolvePayers = async () => [];
    let emailed = 0;
    stubs.sendTransactionalEmail = async () => {
      emailed += 1;
      return { sent: true };
    };

    const result = await processInvoiceAutomatedReminders(
      unpaidInvoice(),
      getDefaultPaymentReminderConfig(),
      new Date('2026-08-20T16:00:00.000Z'),
      { gracePeriodDays: 0 }
    );

    assert.equal(result.slots, 1);
    assert.equal(result.sent, 0);
    assert.equal(emailed, 0);
  });

  it('does not fire overdue reminders during the configured grace period', async () => {
    let emailed = 0;
    stubs.sendTransactionalEmail = async () => {
      emailed += 1;
      return { sent: true };
    };

    const result = await processInvoiceAutomatedReminders(
      unpaidInvoice({ dueDate: new Date('2026-08-20T12:00:00.000Z') }),
      getDefaultPaymentReminderConfig(),
      new Date('2026-08-22T16:00:00.000Z'),
      { gracePeriodDays: 5 }
    );

    assert.equal(result.slots, 0);
    assert.equal(result.sent, 0);
    assert.equal(emailed, 0);
  });

  it('skips invoices whose HOA disabled payment reminders', async () => {
    HOASettings.find = () => ({
      select: () => ({
        lean: async () => ([
          {
            hoaId: HOA_ID,
            paymentReminders: { enabled: false },
            paymentTerm: { gracePeriodDays: 0 },
          },
        ]),
      }),
    });
    Invoice.aggregate = async () => [unpaidInvoice()];

    const batch = await processAutomatedPaymentReminders(new Date('2026-08-20T16:00:00.000Z'));
    assert.equal(batch.skippedDisabled, 1);
    assert.equal(batch.processed, 0);
    assert.equal(batch.sent, 0);
  });

  it('filters reminder slots by due vs overdue phase', () => {
    const slots = [
      { reminderType: 'before_due', daysOffset: 5 },
      { reminderType: 'due_today', daysOffset: 0 },
      { reminderType: 'overdue', daysOffset: -1 },
    ];
    assert.equal(filterReminderSlotsByPhase(slots, 'due').length, 2);
    assert.equal(filterReminderSlotsByPhase(slots, 'overdue').length, 1);
    assert.equal(filterReminderSlotsByPhase(slots, 'all').length, 3);
  });

  it('sends due-today at Eastern midnight EDT, not UTC midnight', async () => {
    const dueToday = unpaidInvoice({ dueDate: new Date('2026-09-14T12:00:00.000Z') });
    const edtMidnight = await processInvoiceAutomatedReminders(
      dueToday,
      getDefaultPaymentReminderConfig(),
      new Date('2026-09-14T04:00:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'America/New_York' },
    );
    assert.equal(edtMidnight.slots, 1);
    assert.equal(edtMidnight.sent, 1);

    const utcMidnight = await processInvoiceAutomatedReminders(
      dueToday,
      getDefaultPaymentReminderConfig(),
      new Date('2026-09-14T00:01:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'America/New_York' },
    );
    assert.equal(utcMidnight.slots, 0);
    assert.equal(utcMidnight.sent, 0);
  });

  it('sends due-today at Eastern standard midnight in January', async () => {
    const result = await processInvoiceAutomatedReminders(
      unpaidInvoice({ dueDate: new Date('2026-01-14T12:00:00.000Z') }),
      getDefaultPaymentReminderConfig(),
      new Date('2026-01-14T05:00:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'America/New_York' },
    );
    assert.equal(result.slots, 1);
    assert.equal(result.sent, 1);
  });

  it('filters invoices to the midnight property timezone only', () => {
    assert.equal(
      invoiceMatchesBillingTimezones('America/New_York', ['America/New_York']),
      true
    );
    assert.equal(
      invoiceMatchesBillingTimezones('America/Los_Angeles', ['America/New_York']),
      false
    );
    assert.equal(invoiceMatchesBillingTimezones('America/New_York', []), true);
  });

  it('does not send due-today for Pacific until Pacific midnight', async () => {
    const dueToday = unpaidInvoice({ dueDate: new Date('2026-09-14T12:00:00.000Z') });
    const atEtMidnight = await processInvoiceAutomatedReminders(
      dueToday,
      getDefaultPaymentReminderConfig(),
      new Date('2026-09-14T04:00:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'America/Los_Angeles' },
    );
    assert.equal(atEtMidnight.slots, 0);
    assert.equal(atEtMidnight.sent, 0);

    const atPacificMidnight = await processInvoiceAutomatedReminders(
      dueToday,
      getDefaultPaymentReminderConfig(),
      new Date('2026-09-14T07:00:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'America/Los_Angeles' },
    );
    assert.equal(atPacificMidnight.slots, 1);
    assert.equal(atPacificMidnight.sent, 1);
  });

  it('does not treat Asia/Kolkata calendar day as Eastern due-today', async () => {
    const dueToday = unpaidInvoice({ dueDate: new Date('2026-09-14T12:00:00.000Z') });
    const easternAtUtcMidnight = await processInvoiceAutomatedReminders(
      dueToday,
      getDefaultPaymentReminderConfig(),
      new Date('2026-09-14T00:01:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'America/New_York' },
    );
    assert.equal(easternAtUtcMidnight.slots, 0);

    const kolkataAtUtcMidnight = await processInvoiceAutomatedReminders(
      dueToday,
      getDefaultPaymentReminderConfig(),
      new Date('2026-09-14T00:01:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'Asia/Kolkata' },
    );
    assert.equal(kolkataAtUtcMidnight.slots, 1);
  });

  it('skips Pacific properties when only Eastern is in the midnight bucket', async () => {
    const pacificPropertyId = '507f1f77bcf86cd799439044';
    Property.find = () => ({
      select: () => ({
        lean: async () => ([
          { _id: pacificPropertyId, billingTimezone: 'America/Los_Angeles' },
        ]),
      }),
    });
    HOASettings.find = () => ({
      select: () => ({
        lean: async () => ([
          {
            hoaId: HOA_ID,
            paymentReminders: { enabled: true },
            paymentTerm: { gracePeriodDays: 0 },
          },
        ]),
      }),
    });
    Invoice.aggregate = async () => [
      unpaidInvoice({
        propertyId: pacificPropertyId,
        dueDate: new Date('2026-09-14T12:00:00.000Z'),
      }),
    ];

    const batch = await processAutomatedPaymentReminders(
      new Date('2026-09-14T04:00:00.000Z'),
      { billingTimezones: ['America/New_York'] },
    );
    assert.equal(batch.skippedTimezone, 1);
    assert.equal(batch.processed, 0);
    assert.equal(batch.sent, 0);
  });

  it('records automated reminder history as system-triggered with no board sender', async () => {
    let pushed;
    Invoice.findByIdAndUpdate = async (_id, update) => {
      pushed = update;
      return {};
    };

    await processInvoiceAutomatedReminders(
      unpaidInvoice({ dueDate: new Date('2026-09-14T12:00:00.000Z') }),
      getDefaultPaymentReminderConfig(),
      new Date('2026-09-14T04:00:00.000Z'),
      { gracePeriodDays: 0, billingTimezone: 'America/New_York' },
    );

    assert.equal(pushed.$push.reminderHistory.source, 'system');
    assert.equal(pushed.$push.reminderHistory.sentBy, null);
    assert.equal(pushed.$push.reminderHistory.reminderType, 'due_today');
  });
});

process.on('exit', () => {
  transactionalEmail.sendTransactionalEmail = originals.sendTransactionalEmail;
  transactionalEmail.wasAlreadySent = originals.wasAlreadySent;
  notifications.notify = originals.notify;
  invoiceEmailHelper.resolveInvoicePayerUsers = originals.resolvePayers;
  invoiceEmailHelper.resolveInvoiceEmailBranding = originals.resolveBranding;
});
