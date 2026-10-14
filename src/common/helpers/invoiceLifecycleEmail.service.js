/**
 * ------------------------------------------------------------------
 * File: invoiceLifecycleEmail.service.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoice.service, hoaInvoiceReminderScheduler.service, invoiceScheduleNotify.service
 * ------------------------------------------------------------------
 */
const Invoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const User = require('../../shared/modules/users/models/user.model');
const logger = require('../logger');
const {
  getDateKeyInTimeZone,
  compareCalendarDateToToday,
  getCalendarDaysLate,
  formatEmailDate,
  formatEmailDateTime,
  dueDateStringExprMongo,
  APP_TIMEZONE,
} = require('./hoaBillingDates');
const { ClockService, DateUtil } = require('../date');
const { INVOICE_STATUS } = require('../constants/invoice');
const {
  buildInvoicePortalUrls,
  getPortalBaseUrl,
  formatAddressForDisplay,
  formatMoney,
  recipientDisplayName,
  resolveInvoicePayerUsers,
  loadInvoiceForEmail,
  resolveInvoiceEmailBranding,
  buildInvoiceEmailSubject,
  mergeInvoiceEmailBranding,
  buildInvoiceEmailSendOptions,
  resolveInvoiceUnitNumber,
} = require('./invoiceNotificationEmailHelper');
const {
  sendTransactionalEmail,
  sendTransactionalEmailInBackground,
  buildEventKey,
} = require('./transactionalEmail.service');
const { buildInvoiceOverduePreheader, buildInvoiceUpdatedPreheader } = require('./emailDisplayHelper');
const { resolveBoardMemberUserIds } = require('../../portals/hoa-board/modules/owners/helpers/hoaBoardMemberIds.helper');
const { enqueueOrRunInBackground } = require('../jobs/enqueue');
const { JOB_TYPES } = require('../jobs/constants');
const { buildJobIdempotencyKey, hashFingerprint } = require('../jobs/idempotency');

/**
 * resolve Invoice Amount For Email
 *
 * Performs logic operations for resolveInvoiceAmountForEmail.
 *
 * @param invoice - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function resolveInvoiceAmountForEmail(invoice, { useSubAmount = false } = {}) {
  const balanceDue = Number(invoice?.balanceDue);
  const subAmount = Number(invoice?.subAmount);
  const principalSubAmount = Number(invoice?.principalSubAmount);
  const candidates = useSubAmount
    ? [subAmount, balanceDue, principalSubAmount]
    : [balanceDue, subAmount, principalSubAmount];
  for (const value of candidates) {
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * build Invoice Email Data
 *
 * Performs logic operations for buildInvoiceEmailData.
 *
 * @param invoice - Request/input argument
 * @param recipient - Request/input argument
 * @param options - Request/input argument
 * @returns Operations result
 */
function buildInvoiceEmailData(invoice, recipient, branding, { useSubAmount = false } = {}) {
  const urls = buildInvoicePortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId
    || `INV-${new Date(invoice.createdAt || Date.now()).toISOString().slice(0, 10)}`;
  const amountValue = resolveInvoiceAmountForEmail(invoice, { useSubAmount });
  return mergeInvoiceEmailBranding(
    {
      recipientName: recipientDisplayName(recipient),
      invoiceNumber,
      propertyName: invoice.propertyName || 'N/A',
      unitNumber: resolveInvoiceUnitNumber(invoice),
      amountDue: formatMoney(amountValue),
      dueDate: invoice.dueDate ? formatEmailDate(invoice.dueDate) : 'N/A',
      ...urls,
    },
    branding
  );
}

async function sendInvoiceCreatedEmail(invoiceInput) {
  const invoiceId = invoiceInput && (invoiceInput._id || invoiceInput);
  if (!invoiceId) return { sent: 0, attempted: 0 };

  const invoice = await loadInvoiceForEmail(invoiceId, { forceReload: true });
  if (!invoice) {
    logger.warn('[InvoiceLifecycleEmail] Invoice not found for created email:', String(invoiceId));
    return { sent: 0, attempted: 0 };
  }

  const recipients = await resolveInvoicePayerUsers(invoice);
  if (!recipients.length) return { sent: 0, attempted: 0 };

  const branding = await resolveInvoiceEmailBranding(invoice);
  let sent = 0;
  for (const user of recipients) {
    const data = buildInvoiceEmailData(invoice, user, branding, { useSubAmount: false });
    const preheaderText = `Invoice #${data.invoiceNumber} - ${data.amountDue} due ${data.dueDate}.`;
    const eventKey = buildEventKey('invoice_created', invoice._id, user.email);
    const result = await sendTransactionalEmail({
      eventKey,
      type: 'invoice-created',
      toEmail: user.email,
      data,
      options: buildInvoiceEmailSendOptions(invoice, branding, {
        template: 'invoice-created',
        subject: buildInvoiceEmailSubject(`New invoice #${data.invoiceNumber}`, branding),
        preheaderText,
      }),
      entityType: 'Invoice',
      entityId: invoice._id,
    }).catch((err) => {
      logger.error('[InvoiceLifecycleEmail] invoice created send failed:', err.message);
      return { sent: false };
    });
    if (result.sent) sent += 1;
  }
  return { sent, attempted: recipients.length };
}

async function sendInvoiceDueTodayEmail(invoice, recipient, dateKey, branding) {
  const resolvedBranding = branding || (await resolveInvoiceEmailBranding(invoice));
  const data = {
    ...buildInvoiceEmailData(invoice, recipient, resolvedBranding),
    headline: 'Your invoice is due today',
    noticeText: 'Please submit payment today to keep your account current.',
    ctaText: 'Pay now',
    ctaUrl: buildInvoicePortalUrls(invoice._id).paymentUrl,
  };
  const eventKey = buildEventKey('invoice_due_today', dateKey, invoice._id, recipient.email);
  return sendTransactionalEmail({
    eventKey,
    type: 'invoice-due-today',
    toEmail: recipient.email,
    data,
    options: buildInvoiceEmailSendOptions(invoice, resolvedBranding, {
      template: 'invoice-due-today',
      subject: buildInvoiceEmailSubject(`Invoice due today - #${data.invoiceNumber}`, resolvedBranding),
      preheaderText: `Invoice #${data.invoiceNumber} is due today.`,
    }),
    entityType: 'Invoice',
    entityId: invoice._id,
  });
}

async function sendInvoiceOverdueEmail(invoice, recipient, dateKey, branding) {
  const resolvedBranding = branding || (await resolveInvoiceEmailBranding(invoice));
  const daysOverdue = getCalendarDaysLate(invoice.dueDate, ClockService.now(), APP_TIMEZONE);
  const data = {
    ...buildInvoiceEmailData(invoice, recipient, resolvedBranding),
    daysOverdue: String(Math.max(daysOverdue, 1)),
    headline: 'Your invoice is overdue',
    noticeText: 'Please pay as soon as possible to avoid additional late fees.',
    ctaText: 'Pay now',
    ctaUrl: buildInvoicePortalUrls(invoice._id).paymentUrl,
  };
  const eventKey = buildEventKey('invoice_overdue', dateKey, invoice._id, recipient.email);
  return sendTransactionalEmail({
    eventKey,
    type: 'invoice-overdue',
    toEmail: recipient.email,
    data,
    options: buildInvoiceEmailSendOptions(invoice, resolvedBranding, {
      template: 'invoice-overdue',
      subject: buildInvoiceEmailSubject(`Invoice overdue - #${data.invoiceNumber}`, resolvedBranding),
      preheaderText: buildInvoiceOverduePreheader({
        invoiceNumber: data.invoiceNumber,
        daysOverdue: data.daysOverdue,
      }),
    }),
    entityType: 'Invoice',
    entityId: invoice._id,
  });
}

async function sendPaymentRecordedEmail({
  invoice: invoiceInput,
  paymentAmount,
  paymentMethod = 'Payment',
  balanceAfter = null,
  paidAt = ClockService.now(),
  recordedAt = null,
  recordedByUserId = null,
}) {
  const normalizedAmount = Number(paymentAmount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    logger.warn('[InvoiceLifecycleEmail] Skipping payment email: invalid paymentAmount', paymentAmount);
    return { sent: 0, attempted: 0 };
  }

  const invoice = await loadInvoiceForEmail(invoiceInput);
  if (!invoice) return { sent: 0 };

  let recordedByName = 'Your HOA';
  if (recordedByUserId) {
    const recorder = await User.findById(recordedByUserId).select('firstName lastName email').lean();
    if (recorder) {
      recordedByName =
        `${recorder.firstName || ''} ${recorder.lastName || ''}`.trim() || recorder.email || recordedByName;
    }
  }

  const recipients = await resolveInvoicePayerUsers(invoice);
  const branding = await resolveInvoiceEmailBranding(invoice);
  const urls = buildInvoicePortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const remainingBalance = balanceAfter != null ? balanceAfter : invoice.balanceDue || 0;
  const paidAtDate = DateUtil.toUTC(paidAt) || ClockService.now();
  const recordedAtDate = DateUtil.toUTC(recordedAt) || paidAtDate || ClockService.now();
  const paidAtKey = getDateKeyInTimeZone(paidAtDate) || getDateKeyInTimeZone(ClockService.now());
  const formattedAmount = formatMoney(normalizedAmount);
  const formattedPaidOn = formatEmailDate(paidAtDate);
  const formattedRecordedAt = formatEmailDateTime(recordedAtDate);

  let sent = 0;
  for (const user of recipients) {
    const eventKey = buildEventKey(
      'payment_recorded',
      invoice._id,
      user.email,
      paidAtKey,
      String(normalizedAmount)
    );
    const result = await sendTransactionalEmail({
      eventKey,
      type: 'payment-recorded',
      toEmail: user.email,
      data: mergeInvoiceEmailBranding(
        {
          recipientName: recipientDisplayName(user),
          invoiceNumber,
          paymentAmount: formattedAmount,
          paymentMethod: paymentMethod || 'Payment',
          recordedByName,
          recordedAt: formattedRecordedAt,
          paidOn: formattedPaidOn,
          propertyName: invoice.propertyName || 'N/A',
          unitNumber: resolveInvoiceUnitNumber(invoice),
          remainingBalance: formatMoney(remainingBalance),
          ...urls,
        },
        branding
      ),
      options: buildInvoiceEmailSendOptions(invoice, branding, {
        template: 'payment-recorded',
        subject: buildInvoiceEmailSubject(`Payment recorded - Invoice ${invoiceNumber}`, branding),
        preheaderText: `Payment of ${formattedAmount} recorded for invoice ${invoiceNumber}.`,
      }),
      entityType: 'Invoice',
      entityId: invoice._id,
    }).catch(() => ({ sent: false }));
    if (result.sent) sent += 1;
  }

  if (invoice.hoaId) {
    const boardIds = await resolveBoardMemberUserIds(invoice.hoaId);
    const boardUsers = await User.find({ _id: { $in: boardIds }, isDeleted: { $ne: true } })
      .select('email firstName lastName')
      .lean();
    for (const boardUser of boardUsers) {
      if (!boardUser.email) continue;
      const eventKey = buildEventKey(
        'payment_received_board',
        invoice._id,
        boardUser.email,
        paidAtKey,
        String(normalizedAmount)
      );
      const result = await sendTransactionalEmail({
        eventKey,
        type: 'payment-received',
        toEmail: boardUser.email,
        data: mergeInvoiceEmailBranding(
          {
            recipientName: recipientDisplayName(boardUser),
            invoiceNumber,
            paymentAmount: formattedAmount,
            paymentMethod: paymentMethod || 'Payment',
            propertyName: invoice.propertyName || 'N/A',
            unitNumber: resolveInvoiceUnitNumber(invoice),
            remainingBalance: formatMoney(remainingBalance),
            paidOn: formattedPaidOn,
            ...urls,
          },
          branding
        ),
        options: buildInvoiceEmailSendOptions(invoice, branding, {
          template: 'payment-received',
          subject: buildInvoiceEmailSubject(`Payment received - Invoice ${invoiceNumber}`, branding),
          preheaderText: `Payment of ${formattedAmount} received for invoice ${invoiceNumber}.`,
        }),
        entityType: 'Invoice',
        entityId: invoice._id,
        metadata: { audience: 'board' },
      }).catch(() => ({ sent: false }));
      if (result.sent) sent += 1;
    }
  }

  return { sent, attempted: recipients.length };
}

async function sendPaymentDeletedEmail({
  invoice: invoiceInput,
  paymentAmount,
  paymentMethod = 'Payment',
  balanceAfter = null,
  paidAt = null,
  deletedAt = ClockService.now(),
  recordedByUserId = null,
  paymentTransactionId = null,
}) {
  const normalizedAmount = Number(paymentAmount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    logger.warn('[InvoiceLifecycleEmail] Skipping payment deleted email: invalid paymentAmount', paymentAmount);
    return { sent: 0, attempted: 0 };
  }

  const invoice = await loadInvoiceForEmail(invoiceInput, { forceReload: true });
  if (!invoice) return { sent: 0, attempted: 0 };

  let deletedByName = 'Your HOA';
  if (recordedByUserId) {
    const actor = await User.findById(recordedByUserId).select('firstName lastName email').lean();
    if (actor) {
      deletedByName =
        `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || actor.email || deletedByName;
    }
  }

  const recipients = await resolveInvoicePayerUsers(invoice);
  if (!recipients.length) return { sent: 0, attempted: 0 };

  const branding = await resolveInvoiceEmailBranding(invoice);
  const urls = buildInvoicePortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const remainingBalance = balanceAfter != null ? balanceAfter : invoice.balanceDue || 0;
  const paidAtDate = DateUtil.toUTC(paidAt) || DateUtil.toUTC(deletedAt) || ClockService.now();
  const deletedAtDate = DateUtil.toUTC(deletedAt) || ClockService.now();
  const deletedAtKey = getDateKeyInTimeZone(deletedAtDate) || getDateKeyInTimeZone(ClockService.now());
  const formattedAmount = formatMoney(normalizedAmount);
  const formattedPaidOn = formatEmailDate(paidAtDate);
  const formattedDeletedAt = formatEmailDateTime(deletedAtDate);
  const paymentKey = paymentTransactionId ? String(paymentTransactionId) : String(normalizedAmount);

  let sent = 0;
  for (const user of recipients) {
    const eventKey = buildEventKey(
      'payment_deleted',
      invoice._id,
      user.email,
      paymentKey,
      deletedAtKey
    );
    const result = await sendTransactionalEmail({
      eventKey,
      type: 'payment-deleted',
      toEmail: user.email,
      data: mergeInvoiceEmailBranding(
        {
          recipientName: recipientDisplayName(user),
          invoiceNumber,
          paymentAmount: formattedAmount,
          paymentMethod: paymentMethod || 'Payment',
          deletedByName,
          deletedAt: formattedDeletedAt,
          paidOn: formattedPaidOn,
          propertyName: invoice.propertyName || 'N/A',
          unitNumber: resolveInvoiceUnitNumber(invoice),
          remainingBalance: formatMoney(remainingBalance),
          ...urls,
        },
        branding
      ),
      options: buildInvoiceEmailSendOptions(invoice, branding, {
        template: 'payment-deleted',
        subject: buildInvoiceEmailSubject(`Payment removed - Invoice ${invoiceNumber}`, branding),
        preheaderText: `Payment of ${formattedAmount} was removed from invoice ${invoiceNumber}.`,
      }),
      entityType: 'Invoice',
      entityId: invoice._id,
      metadata: paymentTransactionId ? { paymentTransactionId: String(paymentTransactionId) } : null,
    }).catch((err) => {
      logger.error('[InvoiceLifecycleEmail] payment deleted send failed:', err.message);
      return { sent: false };
    });
    if (result.sent) sent += 1;
  }

  return { sent, attempted: recipients.length };
}

function normalizeInvoiceUpdateChangeLines(changeDescriptions = []) {
  return (Array.isArray(changeDescriptions) ? changeDescriptions : [changeDescriptions])
    .map((line) => String(line || '').trim())
    .filter(Boolean);
}

function buildInvoiceUpdatedEmailCopy({ invoiceNumber, changeDescriptions = [], activityIntro = '' } = {}) {
  const lines = normalizeInvoiceUpdateChangeLines(changeDescriptions);
  const invoiceLabel = invoiceNumber || 'N/A';
  return {
    introText: String(activityIntro || '').trim()
      || `An update has been made to your invoice #${invoiceLabel}.`,
    changeSummary: lines[0] || '',
    additionalChanges: lines.slice(1),
  };
}

async function sendInvoiceUpdatedEmail({
  invoice: invoiceInput,
  changeDescriptions = [],
  activityIntro = '',
  recordedByUserId = null,
  occurredAt = ClockService.now(),
} = {}) {
  const lines = normalizeInvoiceUpdateChangeLines(changeDescriptions);
  const trimmedIntro = String(activityIntro || '').trim();
  if (!lines.length && !trimmedIntro) {
    return { sent: 0, attempted: 0 };
  }

  const invoice = await loadInvoiceForEmail(invoiceInput);
  if (!invoice) return { sent: 0, attempted: 0 };

  const recipients = await resolveInvoicePayerUsers(invoice);
  if (!recipients.length) return { sent: 0, attempted: 0 };

  const branding = await resolveInvoiceEmailBranding(invoice);
  const urls = buildInvoicePortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const copy = buildInvoiceUpdatedEmailCopy({
    invoiceNumber,
    changeDescriptions: lines,
    activityIntro: trimmedIntro,
  });
  const occurredAtDate = DateUtil.toUTC(occurredAt) || ClockService.now();
  const changeFingerprint = [...lines, trimmedIntro].join('|').slice(0, 180);

  let sent = 0;
  for (const user of recipients) {
    const eventKey = buildEventKey(
      'invoice_updated',
      invoice._id,
      user.email,
      changeFingerprint,
      occurredAtDate.toISOString()
    );
    const result = await sendTransactionalEmail({
      eventKey,
      type: 'invoice-updated',
      toEmail: user.email,
      data: mergeInvoiceEmailBranding(
        {
          recipientName: recipientDisplayName(user),
          invoiceNumber,
          introText: copy.introText,
          changeSummary: copy.changeSummary,
          additionalChanges: copy.additionalChanges,
          propertyName: invoice.propertyName || 'N/A',
          unitNumber: resolveInvoiceUnitNumber(invoice),
          amountDue: formatMoney(resolveInvoiceAmountForEmail(invoice)),
          dueDate: invoice.dueDate ? formatEmailDate(invoice.dueDate) : 'N/A',
          ...urls,
        },
        branding
      ),
      options: buildInvoiceEmailSendOptions(invoice, branding, {
        template: 'invoice-updated',
        subject: buildInvoiceEmailSubject(`Invoice #${invoiceNumber} Updated`, branding),
        preheaderText: buildInvoiceUpdatedPreheader({
          invoiceNumber,
          changeSummary: copy.changeSummary || copy.introText,
        }),
        senderUserId: recordedByUserId || undefined,
      }),
      entityType: 'Invoice',
      entityId: invoice._id,
      metadata: recordedByUserId ? { recordedByUserId: String(recordedByUserId) } : null,
    }).catch((err) => {
      logger.error('[InvoiceLifecycleEmail] invoice updated send failed:', err.message);
      return { sent: false };
    });
    if (result.sent) sent += 1;
  }

  return { sent, attempted: recipients.length };
}

async function sendInvoiceBalanceWaivedEmail({
  invoice: invoiceInput,
  waivedAmount,
  remainingBalance = null,
  waivedAt = ClockService.now(),
  reason = '',
  waivedByUserId = null,
}) {
  const normalizedAmount = Number(waivedAmount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return { sent: 0, attempted: 0 };
  }

  const invoice = await loadInvoiceForEmail(invoiceInput);
  if (!invoice) return { sent: 0 };

  let waivedByName = 'Your HOA';
  if (waivedByUserId) {
    const actor = await User.findById(waivedByUserId).select('firstName lastName email').lean();
    if (actor) {
      waivedByName =
        `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || actor.email || waivedByName;
    }
  }

  const recipients = await resolveInvoicePayerUsers(invoice);
  const branding = await resolveInvoiceEmailBranding(invoice);
  const urls = buildInvoicePortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const remaining = remainingBalance != null ? remainingBalance : invoice.balanceDue || 0;
  const waivedAtDate = DateUtil.toUTC(waivedAt) || ClockService.now();
  const waivedOnKey = getDateKeyInTimeZone(waivedAtDate) || getDateKeyInTimeZone(ClockService.now());
  const formattedWaivedAmount = formatMoney(normalizedAmount);
  const trimmedReason = String(reason || '').trim();

  let sent = 0;
  for (const user of recipients) {
    const eventKey = buildEventKey(
      'invoice_balance_waived',
      invoice._id,
      user.email,
      waivedOnKey,
      String(normalizedAmount)
    );
    const result = await sendTransactionalEmail({
      eventKey,
      type: 'invoice-balance-waived',
      toEmail: user.email,
      data: mergeInvoiceEmailBranding(
        {
          recipientName: recipientDisplayName(user),
          invoiceNumber,
          waivedAmount: formattedWaivedAmount,
          remainingBalance: formatMoney(remaining),
          waivedOn: formatEmailDate(waivedAtDate),
          waivedByName,
          reason: trimmedReason,
          propertyName: invoice.propertyName || 'N/A',
          unitNumber: resolveInvoiceUnitNumber(invoice),
          ...urls,
        },
        branding
      ),
      options: buildInvoiceEmailSendOptions(invoice, branding, {
        template: 'invoice-balance-waived',
        subject: buildInvoiceEmailSubject(`Balance waived - Invoice ${invoiceNumber}`, branding),
        preheaderText: `${formattedWaivedAmount} waived on invoice ${invoiceNumber}.`,
      }),
      entityType: 'Invoice',
      entityId: invoice._id,
    }).catch(() => ({ sent: false }));
    if (result.sent) sent += 1;
  }

  return { sent, attempted: recipients.length };
}

async function processDueTodayInvoiceReminders(referenceDate = ClockService.now()) {
  const { processAutomatedPaymentReminders } = require('./paymentReminderAutomation.service');
  const batch = await processAutomatedPaymentReminders(referenceDate);
  return { dueToday: batch.invoicesWithSlots, sent: batch.sent };
}

async function processOverdueInvoiceReminders(referenceDate = ClockService.now()) {
  const { processAutomatedPaymentReminders } = require('./paymentReminderAutomation.service');
  const batch = await processAutomatedPaymentReminders(referenceDate);
  return { overdue: batch.invoicesWithSlots, sent: batch.sent };
}

function resolveInvoiceId(invoice) {
  if (!invoice) return '';
  if (typeof invoice === 'object') return String(invoice._id || invoice.id || '');
  return String(invoice);
}

/**
 * notify Invoice Created In Background
 *
 * Performs logic operations for notifyInvoiceCreatedInBackground.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function notifyInvoiceCreatedInBackground(invoice) {
  const invoiceId = resolveInvoiceId(invoice);
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_INVOICE_CREATED,
    entityType: 'Invoice',
    entityId: invoiceId,
    idempotencyKey: buildJobIdempotencyKey('EMAIL_INVOICE_CREATED', invoiceId),
    payload: { invoiceId },
    run: () => sendInvoiceCreatedEmail(invoice),
  });
}

/**
 * notify Payment Recorded In Background
 *
 * Performs logic operations for notifyPaymentRecordedInBackground.
 *
 * @param payload - Request/input argument
 * @returns Operations result
 */
function notifyPaymentRecordedInBackground(payload = {}) {
  const invoiceId = resolveInvoiceId(payload.invoice);
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_PAYMENT_RECORDED,
    entityType: 'Invoice',
    entityId: invoiceId,
    eventId: payload.paymentTransactionId || '',
    idempotencyKey: buildJobIdempotencyKey(
      'EMAIL_PAYMENT_RECORDED',
      invoiceId,
      payload.paymentTransactionId || payload.paymentAmount,
      payload.paidAt || payload.recordedAt
    ),
    payload: { ...payload, invoiceId },
    // Deliver with in-app payment notifies (do not depend on job workers).
    preferInline: true,
    run: () => sendPaymentRecordedEmail(payload),
  });
}

function notifyPaymentDeletedInBackground(payload = {}) {
  const invoiceId = resolveInvoiceId(payload.invoice);
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_PAYMENT_DELETED,
    entityType: 'Invoice',
    entityId: invoiceId,
    eventId: payload.paymentTransactionId || '',
    idempotencyKey: buildJobIdempotencyKey(
      'EMAIL_PAYMENT_DELETED',
      invoiceId,
      payload.paymentTransactionId || payload.paymentAmount,
      payload.deletedAt || payload.paidAt
    ),
    payload: { ...payload, invoiceId },
    preferInline: true,
    run: () => sendPaymentDeletedEmail(payload),
  });
}

/**
 * notify Invoice Balance Waived In Background
 *
 * Performs logic operations for notifyInvoiceBalanceWaivedInBackground.
 *
 * @param payload - Request/input argument
 * @returns Operations result
 */
function notifyInvoiceBalanceWaivedInBackground(payload = {}) {
  const invoiceId = resolveInvoiceId(payload.invoice);
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_INVOICE_BALANCE_WAIVED,
    entityType: 'Invoice',
    entityId: invoiceId,
    idempotencyKey: buildJobIdempotencyKey(
      'EMAIL_INVOICE_BALANCE_WAIVED',
      invoiceId,
      payload.waivedAmount,
      payload.occurredAt
    ),
    payload: { ...payload, invoiceId },
    run: () => sendInvoiceBalanceWaivedEmail(payload),
  });
}

function notifyInvoiceUpdatedInBackground(payload = {}) {
  const invoiceId = resolveInvoiceId(payload.invoice);
  const fingerprint = hashFingerprint(
    [payload.activityIntro, ...(payload.changeDescriptions || [])].join('|')
  );
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_INVOICE_UPDATED,
    entityType: 'Invoice',
    entityId: invoiceId,
    eventId: fingerprint,
    idempotencyKey: buildJobIdempotencyKey('EMAIL_INVOICE_UPDATED', invoiceId, fingerprint),
    payload: {
      invoiceId,
      changeDescriptions: payload.changeDescriptions || [],
      activityIntro: payload.activityIntro || '',
      recordedByUserId: payload.recordedByUserId || null,
      occurredAt: payload.occurredAt || null,
    },
    // Electronic processing notices (and other invoice updates) must send with in-app.
    preferInline: true,
    run: () => sendInvoiceUpdatedEmail(payload),
  });
}

const SCHEDULE_INVOICE_EMAIL_SELECT =
  'invoiceId propertyName unit tenants balanceDue dueDate subAmount principalSubAmount hoaId propertyId term generatedFrom status createdAt';

function getInvoiceCalendarYear(dueDate) {
  const key = getDateKeyInTimeZone(dueDate, APP_TIMEZONE);
  if (key) return key.slice(0, 4);
  const parsed = DateUtil.toUTC(dueDate);
  return parsed ? String(parsed.getUTCFullYear()) : String(ClockService.now().getUTCFullYear());
}

function resolveScheduleInvoiceApplicability(invoice, referenceDate = ClockService.now()) {
  if (Number(invoice?.balanceDue) <= 0) return 'Paid';
  if (compareCalendarDateToToday(invoice.dueDate, referenceDate, APP_TIMEZONE) > 0) {
    return 'Scheduled';
  }
  return 'Applicable';
}

function groupScheduleInvoicesByRecipientAndYear(invoices = []) {
  const groupMap = new Map();

  for (const invoice of invoices) {
    if (!invoice || !invoice._id) continue;
    const year = getInvoiceCalendarYear(invoice.dueDate);
    const recipients = Array.isArray(invoice.tenants)
      ? invoice.tenants.filter((tenant) => tenant && tenant.email)
      : [];

    for (const recipient of recipients) {
      const email = String(recipient.email || '').trim().toLowerCase();
      if (!email) continue;
      const key = `${email}:${year}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          recipient,
          invoiceYear: year,
          invoices: [],
        });
      }
      const group = groupMap.get(key);
      if (!group.invoices.some((row) => String(row._id) === String(invoice._id))) {
        group.invoices.push(invoice);
      }
    }
  }

  return Array.from(groupMap.values()).map((group) => ({
    ...group,
    invoices: group.invoices.sort(
      (left, right) => new Date(left.dueDate).getTime() - new Date(right.dueDate).getTime()
    ),
  }));
}

function buildOwnerDisplayName(tenants = []) {
  if (!Array.isArray(tenants) || tenants.length === 0) return 'N/A';
  const names = tenants
    .map((tenant) => recipientDisplayName(tenant))
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'N/A';
}

function buildLocationMapUrl(location = '') {
  const trimmed = String(location || '').trim();
  if (!trimmed || trimmed === 'N/A') return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
}

function buildScheduleInvoiceSummaryRow(invoice, locationByPropertyId = new Map(), options = {}) {
  const propertyId = invoice.propertyId ? String(invoice.propertyId) : '';
  const location = (propertyId && locationByPropertyId.get(propertyId)) || invoice.propertyName || 'N/A';
  const amountValue = resolveInvoiceAmountForEmail(invoice, { useSubAmount: false });
  const invoiceNumber = invoice.invoiceId
    || `INV-${new Date(invoice.createdAt || Date.now()).toISOString().slice(0, 10)}`;

  return {
    invoiceNumber,
    term: invoice.term || 'N/A',
    invoiceDate: invoice.createdAt ? formatEmailDate(invoice.createdAt) : 'N/A',
    dueDate: invoice.dueDate ? formatEmailDate(invoice.dueDate) : 'N/A',
    amountDue: formatMoney(amountValue),
    propertyName: invoice.propertyName || 'N/A',
    unitNumber: resolveInvoiceUnitNumber(invoice),
    location: location || 'N/A',
    locationUrl: buildLocationMapUrl(location),
    ownerName: buildOwnerDisplayName(invoice.tenants),
    applicability: resolveScheduleInvoiceApplicability(invoice),
    viewInvoiceUrl: buildInvoicePortalUrls(invoice._id).viewInvoiceUrl,
    showOwnerColumn: options.showOwnerColumn === true,
  };
}

function buildNextYearOwnerEmailSubject(invoiceCount, branding) {
  const subject = invoiceCount > 1
    ? 'Your Next-Year HOA Invoices Have Been Created'
    : 'Your Next-Year HOA Invoice Has Been Created';
  return buildInvoiceEmailSubject(subject, branding);
}

function buildNextYearBoardEmailSubject(branding) {
  return buildInvoiceEmailSubject('Next-Year HOA Invoices Created', branding);
}

async function loadScheduleInvoicesForEmail(invoiceRefs = []) {
  const ids = (Array.isArray(invoiceRefs) ? invoiceRefs : [])
    .map((invoice) => (invoice && (invoice._id || invoice)))
    .filter(Boolean);

  if (!ids.length) return [];

  return Invoice.find({ _id: { $in: ids } })
    .select(SCHEDULE_INVOICE_EMAIL_SELECT)
    .populate('tenants', 'firstName lastName email')
    .lean();
}

async function loadPropertyLocationsForInvoices(invoices = []) {
  const propertyIds = [
    ...new Set(
      invoices
        .map((invoice) => invoice.propertyId)
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];

  if (!propertyIds.length) return new Map();

  const properties = await Property.find({ _id: { $in: propertyIds } })
    .select('address name')
    .lean();

  return new Map(
    properties.map((property) => [
      String(property._id),
      formatAddressForDisplay(property.address) || property.name || '',
    ])
  );
}

async function sendConsolidatedInvoiceScheduleEmail({
  recipient,
  invoiceYear,
  invoices = [],
  locationByPropertyId = new Map(),
  audience = 'owner',
  isNextYear = false,
}) {
  if (!recipient?.email || !invoiceYear || !Array.isArray(invoices) || invoices.length === 0) {
    return { sent: 0, attempted: 0 };
  }

  const branding = await resolveInvoiceEmailBranding(invoices[0]);
  const showOwnerColumn = audience === 'board';
  const invoiceRows = invoices.map((invoice) =>
    buildScheduleInvoiceSummaryRow(invoice, locationByPropertyId, { showOwnerColumn })
  );
  const totalAmountDueValue = invoices.reduce(
    (sum, invoice) => sum + resolveInvoiceAmountForEmail(invoice, { useSubAmount: false }),
    0
  );
  const invoiceIds = invoices.map((invoice) => String(invoice._id)).sort();
  const viewInvoicesUrl = `${getPortalBaseUrl()}/income`;
  const invoiceCount = invoices.length;
  const data = mergeInvoiceEmailBranding(
    {
      recipientName: recipientDisplayName(recipient),
      invoiceYear,
      invoiceCount: String(invoiceCount),
      hasMultipleInvoices: invoiceCount > 1,
      totalAmountDue: formatMoney(totalAmountDueValue),
      invoiceRows,
      viewInvoicesUrl,
      isNextYear,
      audience,
      showOwnerColumn,
      emailHeadline: isNextYear
        ? (audience === 'board'
          ? 'Next-Year HOA Invoices Created'
          : (invoiceCount > 1 ? 'Your Next-Year HOA Invoices Have Been Created' : 'Your Next-Year HOA Invoice Has Been Created'))
        : `Invoices for ${invoiceYear}`,
      introText: isNextYear
        ? (audience === 'board'
          ? `Next-year invoices have been automatically generated for the applicable HOA owners for <strong>${invoiceYear}</strong>. Please review the upcoming invoices below.`
          : `Your invoice${invoiceCount > 1 ? 's' : ''} for the upcoming billing year (<strong>${invoiceYear}</strong>) ${invoiceCount > 1 ? 'have' : 'has'} been created automatically in advance. Please review the details below and payment schedule.`)
        : `Invoices have been created for <strong>${invoiceYear}</strong> for the following unit${invoiceCount > 1 ? 's' : ''}/propert${invoiceCount > 1 ? 'ies' : 'y'}. Please review the details below.`,
    },
    branding
  );
  const preheaderText = isNextYear
    ? (audience === 'board'
      ? `${invoiceCount} next-year invoice${invoiceCount === 1 ? '' : 's'} created for ${invoiceYear} - review required.`
      : `Your next-year HOA invoice${invoiceCount === 1 ? '' : 's'} for ${invoiceYear} - ${data.totalAmountDue} total due.`)
    : `${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} created for ${invoiceYear} - ${data.totalAmountDue} total due.`;
  const eventKeySuffix = isNextYear ? 'next_year' : 'invoice_schedule_summary';
  const eventKey = buildEventKey(
    eventKeySuffix,
    audience,
    recipient.email,
    invoiceYear,
    invoiceIds.join(',')
  );

  const subject = isNextYear
    ? (audience === 'board'
      ? buildNextYearBoardEmailSubject(branding)
      : buildNextYearOwnerEmailSubject(invoiceCount, branding))
    : buildInvoiceEmailSubject(`Invoices created for ${invoiceYear}`, branding);

  return sendTransactionalEmail({
    eventKey,
    type: 'invoice-schedule-summary',
    toEmail: recipient.email,
    data,
    options: buildInvoiceEmailSendOptions(invoices[0], branding, {
      template: 'invoice-schedule-summary',
      subject,
      preheaderText,
    }),
    entityType: 'Invoice',
    entityId: invoices[0]._id,
    metadata: {
      invoiceYear,
      invoiceCount,
      invoiceIds,
      audience,
      isNextYear,
    },
  }).catch((err) => {
    logger.error('[InvoiceLifecycleEmail] schedule summary send failed:', err.message);
    return { sent: false };
  });
}

/**
 * Send one consolidated email per owner per calendar year for schedule-generated invoices.
 */
async function sendConsolidatedScheduleInvoiceCreatedEmails(invoiceRefs = []) {
  const invoices = await loadScheduleInvoicesForEmail(invoiceRefs);
  if (!invoices.length) return { sent: 0, emails: 0, attempted: 0 };

  const locationByPropertyId = await loadPropertyLocationsForInvoices(invoices);
  const groups = groupScheduleInvoicesByRecipientAndYear(invoices);

  let sent = 0;
  for (const group of groups) {
    const result = await sendConsolidatedInvoiceScheduleEmail({
      recipient: group.recipient,
      invoiceYear: group.invoiceYear,
      invoices: group.invoices,
      locationByPropertyId,
      audience: 'owner',
      isNextYear: false,
    });
    if (result.sent) sent += 1;
  }

  return { sent, emails: groups.length, attempted: groups.length };
}

async function sendConsolidatedNextYearBoardEmails(invoices = [], locationByPropertyId = new Map()) {
  const byHoaYear = new Map();
  for (const invoice of invoices) {
    if (!invoice?.hoaId) continue;
    const year = getInvoiceCalendarYear(invoice.dueDate);
    const key = `${String(invoice.hoaId)}:${year}`;
    if (!byHoaYear.has(key)) {
      byHoaYear.set(key, { hoaId: invoice.hoaId, invoiceYear: year, invoices: [] });
    }
    const bucket = byHoaYear.get(key);
    if (!bucket.invoices.some((row) => String(row._id) === String(invoice._id))) {
      bucket.invoices.push(invoice);
    }
  }

  let sent = 0;
  let attempted = 0;
  for (const bucket of byHoaYear.values()) {
    const boardIds = await resolveBoardMemberUserIds(bucket.hoaId);
    if (!boardIds.length) continue;
    const boardUsers = await User.find({ _id: { $in: boardIds }, isDeleted: { $ne: true } })
      .select('email firstName lastName')
      .lean();
    const sortedInvoices = bucket.invoices.sort(
      (left, right) => new Date(left.dueDate).getTime() - new Date(right.dueDate).getTime()
    );
    for (const boardUser of boardUsers) {
      if (!boardUser.email) continue;
      attempted += 1;
      const result = await sendConsolidatedInvoiceScheduleEmail({
        recipient: boardUser,
        invoiceYear: bucket.invoiceYear,
        invoices: sortedInvoices,
        locationByPropertyId,
        audience: 'board',
        isNextYear: true,
      });
      if (result.sent) sent += 1;
    }
  }

  return { sent, attempted };
}

/**
 * Send consolidated next-year emails to owners and board members.
 */
async function sendConsolidatedNextYearInvoiceCreatedEmails(invoiceRefs = []) {
  const invoices = await loadScheduleInvoicesForEmail(invoiceRefs);
  if (!invoices.length) return { sent: 0, emails: 0, attempted: 0 };

  const locationByPropertyId = await loadPropertyLocationsForInvoices(invoices);
  const ownerGroups = groupScheduleInvoicesByRecipientAndYear(invoices);

  let sent = 0;
  let attempted = 0;
  for (const group of ownerGroups) {
    attempted += 1;
    const result = await sendConsolidatedInvoiceScheduleEmail({
      recipient: group.recipient,
      invoiceYear: group.invoiceYear,
      invoices: group.invoices,
      locationByPropertyId,
      audience: 'owner',
      isNextYear: true,
    });
    if (result.sent) sent += 1;
  }

  const boardResult = await sendConsolidatedNextYearBoardEmails(invoices, locationByPropertyId);
  sent += boardResult.sent || 0;
  attempted += boardResult.attempted || 0;

  return { sent, emails: attempted, attempted };
}

module.exports = {
  sendInvoiceCreatedEmail,
  sendInvoiceDueTodayEmail,
  sendInvoiceOverdueEmail,
  sendPaymentRecordedEmail,
  sendPaymentDeletedEmail,
  sendInvoiceBalanceWaivedEmail,
  sendInvoiceUpdatedEmail,
  processDueTodayInvoiceReminders,
  processOverdueInvoiceReminders,
  notifyInvoiceCreatedInBackground,
  notifyPaymentRecordedInBackground,
  notifyPaymentDeletedInBackground,
  notifyInvoiceBalanceWaivedInBackground,
  notifyInvoiceUpdatedInBackground,
  buildInvoiceEmailData,
  buildInvoiceUpdatedEmailCopy,
  resolveInvoiceAmountForEmail,
  sendConsolidatedScheduleInvoiceCreatedEmails,
  sendConsolidatedNextYearInvoiceCreatedEmails,
  sendConsolidatedInvoiceScheduleEmail,
  groupScheduleInvoicesByRecipientAndYear,
  buildScheduleInvoiceSummaryRow,
  getInvoiceCalendarYear,
  resolveScheduleInvoiceApplicability,
};
