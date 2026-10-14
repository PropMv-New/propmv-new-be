'use strict';

const Invoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const HOASettings = require('../../portals/hoa-board/modules/hoa-settings/model/hoaSettings.model');
const EmailDeliveryLog = require('../models/emailDeliveryLog.model');
const logger = require('../logger');
const { ClockService } = require('../date');
const { INVOICE_STATUS } = require('../constants/invoice');
const {
  billingCalendarDateKey,
  getDateKeyInTimeZone,
  dueDateStringExprMongo,
  formatEmailDate,
  formatDateInAppTimezone,
  getCalendarDaysLate,
} = require('./hoaBillingDates');
const {
  resolveInvoicePayerUsers,
  resolveInvoiceEmailBranding,
  buildInvoiceEmailSubject,
  buildInvoicePortalUrls,
  recipientDisplayName,
  mergeInvoiceEmailBranding,
  buildInvoiceEmailSendOptions,
  formatMoney,
  resolveInvoiceUnitNumber,
} = require('./invoiceNotificationEmailHelper');
const { buildInvoiceOverduePreheader } = require('./emailDisplayHelper');
const {
  sendTransactionalEmail,
  wasAlreadySent,
} = require('./transactionalEmail.service');
const { notify, EVENTS } = require('../notifications');
const {
  normalizePaymentReminderConfig,
  resolveReminderTimezone,
  calendarDaysUntilDue,
  resolveReminderSlotsForToday,
  buildReminderEventKey,
} = require('./paymentReminderConfig.helper');

const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

const UNPAID_INVOICE_MATCH = {
  isDeleted: { $ne: true },
  generatedFrom: { $ne: 'late_fee' },
  balanceDue: { $gt: 0 },
  status: {
    $in: [
      INVOICE_STATUS.PENDING,
      INVOICE_STATUS.PARTIALLY_PAID,
      INVOICE_STATUS.OVERDUE,
      INVOICE_STATUS.PROCESSING,
    ],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(task, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_SEND_ATTEMPTS) {
        logger.warn(`[PaymentReminderAutomation] ${label} attempt ${attempt} failed, retrying:`, err?.message || err);
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

function buildReminderSubject(invoice, slot, config, branding) {
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const templateSubject = config.templates?.[slot.templateKey]?.subject;
  if (templateSubject) {
    return buildInvoiceEmailSubject(templateSubject.replace(/\{\{invoiceNumber\}\}/g, invoiceNumber), branding);
  }
  if (slot.reminderType === 'before_due') {
    return buildInvoiceEmailSubject(
      `Payment reminder - Invoice #${invoiceNumber} due in ${slot.daysOffset} day${slot.daysOffset === 1 ? '' : 's'}`,
      branding
    );
  }
  if (slot.reminderType === 'due_today') {
    return buildInvoiceEmailSubject(`Invoice due today - #${invoiceNumber}`, branding);
  }
  const daysOverdue = Math.abs(slot.daysOffset || 1);
  return buildInvoiceEmailSubject(`Invoice overdue - #${invoiceNumber}`, branding);
}

function buildReminderEmailData(invoice, recipient, branding, slot, config) {
  const base = mergeInvoiceEmailBranding(
    {
      recipientName: recipientDisplayName(recipient),
      invoiceNumber: invoice.invoiceId || String(invoice._id),
      propertyName: invoice.propertyName || 'N/A',
      unitNumber: resolveInvoiceUnitNumber(invoice),
      amountDue: formatMoney(invoice.balanceDue),
      dueDate: invoice.dueDate ? formatEmailDate(invoice.dueDate) : 'N/A',
      ...buildInvoicePortalUrls(invoice._id),
    },
    branding
  );

  const customBody = config.templates?.[slot.templateKey]?.body || '';
  const daysOverdue = slot.reminderType === 'overdue'
    ? String(Math.max(getCalendarDaysLate(invoice.dueDate, ClockService.now(), resolveReminderTimezone(config, branding?.billingTimezone)), 1))
    : undefined;

  if (slot.reminderType === 'before_due') {
    return {
      ...base,
      headline: `Payment due in ${slot.daysOffset} day${slot.daysOffset === 1 ? '' : 's'}`,
      noticeText: customBody || `Your invoice is due in ${slot.daysOffset} day${slot.daysOffset === 1 ? '' : 's'}. Please submit payment to keep your account current.`,
      ctaText: 'Pay now',
      ctaUrl: base.paymentUrl,
    };
  }

  if (slot.reminderType === 'due_today') {
    return {
      ...base,
      headline: 'Your invoice is due today',
      noticeText: customBody || 'Please submit payment today to keep your account current.',
      ctaText: 'Pay now',
      ctaUrl: base.paymentUrl,
    };
  }

  return {
    ...base,
    daysOverdue,
    headline: 'Your invoice is overdue',
    noticeText: customBody || 'Please pay as soon as possible to avoid additional late fees.',
    ctaText: 'Pay now',
    ctaUrl: base.paymentUrl,
  };
}

function resolveEmailTemplate(slot) {
  if (slot.reminderType === 'due_today') return 'invoice-due-today';
  if (slot.reminderType === 'overdue') return 'invoice-overdue';
  return 'invoice-due-today';
}

async function countOverdueRemindersSent(invoiceId) {
  const count = await EmailDeliveryLog.countDocuments({
    entityType: 'Invoice',
    entityId: String(invoiceId),
    status: 'sent',
    'metadata.reminderType': 'overdue',
  });
  return count;
}

async function recordAutomatedReminderHistory(invoiceId, { recipients, subject, slot, channels }) {
  const channelList = Object.entries(channels || {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  const now = ClockService.now();
  await Invoice.findByIdAndUpdate(invoiceId, {
    $push: {
      reminderHistory: {
        recipients,
        subject,
        sentAt: now,
        sentBy: null,
        source: 'system',
        reminderType: slot.reminderType,
        daysOffset: slot.daysOffset,
        channels: channelList,
      },
    },
  }).catch((err) => {
    logger.error('[PaymentReminderAutomation] Failed to record reminder history:', err?.message || err);
  });
}

async function wasReminderAlreadySentToday(invoiceId, slot, dateKey, timezone) {
  const invoice = await Invoice.findById(invoiceId).select('reminderHistory').lean();
  return (invoice?.reminderHistory || []).some((row) => {
    if (row.source !== 'system') return false;
    if (row.reminderType !== slot.reminderType) return false;
    if (row.daysOffset !== slot.daysOffset) return false;
    const sentKey = getDateKeyInTimeZone(row.sentAt, timezone);
    return sentKey === dateKey;
  });
}

async function recordReminderDeliveryLog({ eventKey, recipientEmail, invoiceId, slot, templateName }) {
  await EmailDeliveryLog.create({
    eventKey,
    templateName,
    recipientEmail,
    entityType: 'Invoice',
    entityId: String(invoiceId),
    status: 'sent',
    metadata: {
      reminderType: slot.reminderType,
      daysOffset: slot.daysOffset,
      automated: true,
      channel: templateName,
    },
  }).catch(() => {});
}

async function sendAutomatedReminderForRecipient({
  invoice,
  recipient,
  slot,
  config,
  dateKey,
  branding,
  gracePeriodDays,
  billingTimezone,
}) {
  const timezone = resolveReminderTimezone(config, billingTimezone);
  const eventKey = buildReminderEventKey(
    slot.reminderType,
    slot.daysOffset,
    dateKey,
    invoice._id,
    recipient.email
  );

  if (await wasAlreadySent(eventKey)) {
    return { sent: false, skipped: true, reason: 'duplicate' };
  }

  const alreadySentForSlot = await wasReminderAlreadySentToday(
    invoice._id,
    slot,
    dateKey,
    timezone
  );
  if (alreadySentForSlot) {
    return { sent: false, skipped: true, reason: 'duplicate_history' };
  }

  const subject = buildReminderSubject(invoice, slot, config, branding);
  const channelsSent = [];
  let emailSent = false;

  if (config.channels.email) {
    const data = buildReminderEmailData(invoice, recipient, branding, slot, config);
    const template = resolveEmailTemplate(slot);
    const preheaderText = slot.reminderType === 'overdue'
      ? buildInvoiceOverduePreheader({ invoiceNumber: data.invoiceNumber, daysOverdue: data.daysOverdue })
      : slot.reminderType === 'before_due'
        ? `Invoice #${data.invoiceNumber} is due in ${slot.daysOffset} days.`
        : `Invoice #${data.invoiceNumber} is due today.`;

    const result = await sendWithRetry(
      () => sendTransactionalEmail({
        eventKey,
        type: template,
        toEmail: recipient.email,
        data,
        options: buildInvoiceEmailSendOptions(invoice, branding, {
          template,
          subject,
          preheaderText,
        }),
        entityType: 'Invoice',
        entityId: invoice._id,
        metadata: {
          reminderType: slot.reminderType,
          daysOffset: slot.daysOffset,
          automated: true,
        },
      }),
      `email ${eventKey}`
    ).catch((err) => {
      logger.error('[PaymentReminderAutomation] Email send failed:', err?.message || err);
      return { sent: false };
    });

    if (result?.sent) {
      emailSent = true;
      channelsSent.push('email');
    }
  }

  if (config.channels.inApp && recipient._id) {
    const payerId = String(recipient._id);
    const portalUrls = buildInvoicePortalUrls(invoice._id);
    const unitName = resolveInvoiceUnitNumber(invoice);
    const unitLabel = unitName === 'N/A' ? '' : unitName;
    await sendWithRetry(
      () => notify(
        EVENTS.PAYMENT_REMINDER,
        {
          invoiceNumber: invoice.invoiceId || String(invoice._id),
          propertyName: invoice.propertyName || 'your property',
          unit: unitLabel,
          unitName: unitLabel,
          amount: invoice.balanceDue,
          balanceDueFormatted: formatMoney(invoice.balanceDue),
          dueDate: invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : '',
          status: invoice.status,
          paymentUrl: portalUrls.paymentUrl,
          viewInvoiceUrl: portalUrls.viewInvoiceUrl,
          customMessage: slot.reminderType === 'overdue'
            ? 'Your invoice is overdue. Please pay as soon as possible.'
            : slot.reminderType === 'before_due'
              ? `Your invoice is due in ${slot.daysOffset} day${slot.daysOffset === 1 ? '' : 's'}.`
              : 'Your invoice is due today.',
        },
        [payerId],
        {
          invoiceId: String(invoice._id),
          invoiceNumber: invoice.invoiceId,
          eventKey,
          reminderType: slot.reminderType,
        }
      ),
      `in-app ${eventKey}`
    ).then(async () => {
      channelsSent.push('inApp');
      if (!emailSent) {
        await recordReminderDeliveryLog({
          eventKey,
          recipientEmail: recipient.email,
          invoiceId: invoice._id,
          slot,
          templateName: 'payment-reminder-in-app',
        });
      }
    }).catch((err) => {
      logger.error('[PaymentReminderAutomation] In-app notify failed:', err?.message || err);
    });
  }

  if (config.channels.push) {
    logger.debug('[PaymentReminderAutomation] Push channel requested but not yet supported; skipped.');
  }

  const sent = channelsSent.length > 0;
  return { sent, skipped: false, channelsSent, emailSent, subject, eventKey };
}

function filterReminderSlotsByPhase(slots = [], reminderPhase = 'all') {
  if (!reminderPhase || reminderPhase === 'all') return slots;
  if (reminderPhase === 'due') {
    return slots.filter((slot) => slot.reminderType === 'before_due' || slot.reminderType === 'due_today');
  }
  if (reminderPhase === 'overdue') {
    return slots.filter((slot) => slot.reminderType === 'overdue');
  }
  return slots;
}

async function processInvoiceAutomatedReminders(
  invoice,
  config,
  referenceDate,
  settingsContext = {},
  options = {},
) {
  const timezone = resolveReminderTimezone(config, settingsContext.billingTimezone);
  const todayKey = getDateKeyInTimeZone(referenceDate, timezone);
  const dueDateKey = billingCalendarDateKey(invoice.dueDate, timezone);
  if (!todayKey || !dueDateKey) return { slots: 0, sent: 0 };

  const daysUntilDue = calendarDaysUntilDue(todayKey, dueDateKey);
  const gracePeriodDays = settingsContext.gracePeriodDays ?? 0;
  const overdueRemindersSent = daysUntilDue < 0
    ? await countOverdueRemindersSent(invoice._id)
    : 0;

  const slots = filterReminderSlotsByPhase(
    resolveReminderSlotsForToday(config, daysUntilDue, {
      gracePeriodDays,
      overdueRemindersSent,
    }),
    options.reminderPhase || settingsContext.reminderPhase || 'all',
  );

  if (!slots.length) return { slots: 0, sent: 0 };

  const [branding, recipients] = await Promise.all([
    resolveInvoiceEmailBranding(invoice),
    resolveInvoicePayerUsers(invoice),
  ]);

  if (!recipients.length) return { slots: slots.length, sent: 0 };

  let sent = 0;
  for (const slot of slots) {
    const deliveredRecipients = [];
    let lastSubject = '';

    for (const recipient of recipients) {
      if (!recipient?.email) continue;
      const result = await sendAutomatedReminderForRecipient({
        invoice,
        recipient,
        slot,
        config,
        dateKey: todayKey,
        branding,
        gracePeriodDays,
        billingTimezone: timezone,
      }).catch(() => ({ sent: false }));

      if (result.sent) {
        sent += 1;
        deliveredRecipients.push(recipient.email);
        lastSubject = result.subject || lastSubject;
      }
    }

    if (deliveredRecipients.length) {
      await recordAutomatedReminderHistory(invoice._id, {
        recipients: deliveredRecipients,
        subject: lastSubject,
        slot,
        channels: config.channels,
      });
    }
  }

  return { slots: slots.length, sent };
}

async function loadPropertyTimezoneMap(propertyIds = []) {
  const Property = require('../../portals/hoa-board/modules/property/model/property.model');
  const { resolvePropertyBillingTimezone } = require('./billingCalendar');
  const ids = [...new Set(
    (propertyIds || [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id !== 'undefined' && id !== 'null')
  )];
  if (ids.length === 0) return new Map();

  const rows = await Property.find({ _id: { $in: ids }, isDeleted: { $ne: true } })
    .select('_id billingTimezone')
    .lean();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row._id), resolvePropertyBillingTimezone(row));
  }
  return map;
}

function invoiceMatchesBillingTimezones(resolvedTimezone, billingTimezones) {
  if (!Array.isArray(billingTimezones) || billingTimezones.length === 0) return true;
  return billingTimezones.includes(resolvedTimezone);
}

async function loadHoaReminderConfigMap() {
  const rows = await HOASettings.find({}).select('hoaId paymentReminders paymentTerm').lean();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.hoaId), {
      config: normalizePaymentReminderConfig(row),
      gracePeriodDays: Number(row.paymentTerm?.gracePeriodDays) || 0,
    });
  }
  return map;
}

async function loadUnpaidInvoicesForReminders() {
  return Invoice.aggregate([
    { $match: UNPAID_INVOICE_MATCH },
    {
      $project: {
        invoiceId: 1,
        propertyName: 1,
        unit: 1,
        tenants: 1,
        balanceDue: 1,
        dueDate: 1,
        hoaId: 1,
        status: 1,
        subAmount: 1,
        type: 1,
        propertyId: 1,
      },
    },
  ]);
}

/**
 * Process configurable automated payment reminders for all unpaid HOA invoices.
 */
async function processAutomatedPaymentReminders(referenceDate = ClockService.now(), options = {}) {
  const reminderPhase = options.reminderPhase || 'all';
  const billingTimezones = options.billingTimezones;
  const configMap = await loadHoaReminderConfigMap();
  const invoices = await loadUnpaidInvoicesForReminders();
  const propertyTzMap = await loadPropertyTimezoneMap(invoices.map((row) => row.propertyId));

  let processed = 0;
  let invoicesWithSlots = 0;
  let sent = 0;
  let skippedDisabled = 0;
  let skippedTimezone = 0;

  for (const invoice of invoices) {
    const hoaKey = invoice.hoaId ? String(invoice.hoaId) : '';
    const hoaContext = configMap.get(hoaKey) || {
      config: normalizePaymentReminderConfig({}),
      gracePeriodDays: 0,
    };

    if (!hoaContext.config.enabled) {
      skippedDisabled += 1;
      continue;
    }

    const billingTimezone = propertyTzMap.get(String(invoice.propertyId || ''))
      || resolveReminderTimezone(hoaContext.config);
    if (!invoiceMatchesBillingTimezones(billingTimezone, billingTimezones)) {
      skippedTimezone += 1;
      continue;
    }

    processed += 1;
    const result = await processInvoiceAutomatedReminders(
      invoice,
      hoaContext.config,
      referenceDate,
      { gracePeriodDays: hoaContext.gracePeriodDays, reminderPhase, billingTimezone },
    ).catch((err) => {
      logger.error('[PaymentReminderAutomation] Invoice processing failed:', invoice._id, err?.message || err);
      return { slots: 0, sent: 0 };
    });

    if (result.slots > 0) invoicesWithSlots += 1;
    sent += result.sent || 0;
  }

  return {
    processed,
    invoicesWithSlots,
    sent,
    skippedDisabled,
    skippedTimezone,
    totalUnpaid: invoices.length,
  };
}

/**
 * Cron entry: find unpaid invoices that may need reminders and enqueue per-invoice jobs.
 * Does not send emails itself.
 */
async function enqueueAutomatedPaymentReminders(referenceDate = ClockService.now(), options = {}) {
  const { enqueueBackgroundJob } = require('../jobs/enqueue');
  const { JOB_TYPES } = require('../jobs/constants');
  const { buildJobIdempotencyKey } = require('../jobs/idempotency');
  const { isBackgroundJobsEnabled } = require('../jobs/config');
  const reminderPhase = options.reminderPhase || 'all';

  if (!isBackgroundJobsEnabled()) {
    return processAutomatedPaymentReminders(referenceDate, { reminderPhase, billingTimezones: options.billingTimezones });
  }

  const configMap = await loadHoaReminderConfigMap();
  const invoices = await loadUnpaidInvoicesForReminders();
  const propertyTzMap = await loadPropertyTimezoneMap(invoices.map((row) => row.propertyId));
  let processed = 0;
  let enqueued = 0;
  let duplicate = 0;
  let skippedDisabled = 0;
  let skippedTimezone = 0;

  for (const invoice of invoices) {
    const hoaKey = invoice.hoaId ? String(invoice.hoaId) : '';
    const hoaContext = configMap.get(hoaKey) || {
      config: normalizePaymentReminderConfig({}),
      gracePeriodDays: 0,
    };
    if (!hoaContext.config.enabled) {
      skippedDisabled += 1;
      continue;
    }
    const timezone = propertyTzMap.get(String(invoice.propertyId || ''))
      || resolveReminderTimezone(hoaContext.config);
    if (!invoiceMatchesBillingTimezones(timezone, options.billingTimezones)) {
      skippedTimezone += 1;
      continue;
    }
    processed += 1;
    const dateKey = getDateKeyInTimeZone(referenceDate, timezone);
    const result = await enqueueBackgroundJob({
      jobType: JOB_TYPES.INVOICE_PAYMENT_REMINDER,
      entityType: 'Invoice',
      entityId: invoice._id,
      idempotencyKey: buildJobIdempotencyKey(
        'INVOICE_PAYMENT_REMINDER',
        invoice._id,
        dateKey,
        timezone,
        reminderPhase === 'all' ? '' : reminderPhase,
      ),
      payload: {
        invoiceId: String(invoice._id),
        referenceDate: referenceDate.toISOString ? referenceDate.toISOString() : String(referenceDate),
        dateKey,
        reminderPhase,
        billingTimezone: timezone,
      },
    });
    if (result.duplicate) duplicate += 1;
    else enqueued += 1;
  }

  return {
    processed,
    enqueued,
    duplicate,
    skippedDisabled,
    skippedTimezone,
    totalUnpaid: invoices.length,
    sent: 0,
    invoicesWithSlots: enqueued,
  };
}

async function enqueueFailedReminderRetry(referenceDate = ClockService.now(), options = {}) {
  const { enqueueBackgroundJob } = require('../jobs/enqueue');
  const { JOB_TYPES } = require('../jobs/constants');
  const { buildJobIdempotencyKey } = require('../jobs/idempotency');
  const { isBackgroundJobsEnabled } = require('../jobs/config');
  if (!isBackgroundJobsEnabled()) {
    return retryFailedAutomatedReminders();
  }
  const dateKey = getDateKeyInTimeZone(referenceDate, options.billingTimezones?.[0]);
  const result = await enqueueBackgroundJob({
    jobType: JOB_TYPES.INVOICE_PAYMENT_REMINDER_RETRY,
    entityType: 'Invoice',
    entityId: 'reminder-retry',
    idempotencyKey: buildJobIdempotencyKey(
      'INVOICE_PAYMENT_REMINDER_RETRY',
      dateKey,
      Array.isArray(options.billingTimezones) ? options.billingTimezones.join(',') : '',
    ),
    payload: { dateKey, billingTimezones: options.billingTimezones || [] },
  });
  return { enqueued: result.duplicate ? 0 : 1, duplicate: result.duplicate };
}

/**
 * Retry failed automated reminder emails from the last 48 hours.
 */
async function retryFailedAutomatedReminders() {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const failed = await EmailDeliveryLog.find({
    status: 'failed',
    templateName: { $in: ['invoice-due-today', 'invoice-overdue'] },
    createdAt: { $gte: since },
    'metadata.automated': true,
  })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  let retried = 0;
  let recovered = 0;

  for (const row of failed) {
    if (!row.entityId || !row.recipientEmail) continue;
    const invoice = await Invoice.findById(row.entityId).lean();
    if (!invoice || Number(invoice.balanceDue) <= 0) continue;

    const hoaSettings = invoice.hoaId
      ? await HOASettings.findOne({ hoaId: invoice.hoaId }).lean()
      : null;
    const config = normalizePaymentReminderConfig(hoaSettings || {});
    if (!config.enabled || !config.channels.email) continue;

    retried += 1;
    const alreadySent = row.eventKey ? await wasAlreadySent(row.eventKey) : false;
    if (alreadySent) continue;

    const recipient = { email: row.recipientEmail, firstName: '', lastName: '' };
    const slot = {
      reminderType: row.metadata?.reminderType || 'overdue',
      daysOffset: row.metadata?.daysOffset ?? -1,
      templateKey: row.metadata?.reminderType === 'before_due' ? 'beforeDue' : row.metadata?.reminderType === 'due_today' ? 'onDueDate' : 'overdue',
    };
    const timezone = resolveReminderTimezone(config, hoaSettings?.billingTimezone);
    const dateKey = getDateKeyInTimeZone(ClockService.now(), timezone);
    const branding = await resolveInvoiceEmailBranding(invoice);

    const result = await sendAutomatedReminderForRecipient({
      invoice,
      recipient,
      slot,
      config,
      dateKey,
      branding,
      gracePeriodDays: Number(hoaSettings?.paymentTerm?.gracePeriodDays) || 0,
      billingTimezone: timezone,
    }).catch(() => ({ sent: false }));

    if (result.sent) recovered += 1;
  }

  return { retried, recovered };
}

module.exports = {
  processAutomatedPaymentReminders,
  processInvoiceAutomatedReminders,
  filterReminderSlotsByPhase,
  retryFailedAutomatedReminders,
  enqueueAutomatedPaymentReminders,
  enqueueFailedReminderRetry,
  invoiceMatchesBillingTimezones,
  UNPAID_INVOICE_MATCH,
};
