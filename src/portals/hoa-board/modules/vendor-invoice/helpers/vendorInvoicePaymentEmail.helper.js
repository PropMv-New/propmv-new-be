/**
 * Email recipients when a payment is recorded on a vendor invoice (partial or full).
 *
 * - Board + assignee: actor excluded (same as other vendor-invoice notices)
 * - Vendor (payee): ALWAYS notified for payment emails — never excluded as actor,
 *   because vendors can Record Payment and still need a payment-completion receipt.
 */

const mongoose = require('mongoose');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');
const {
  sendTransactionalEmail,
  buildEventKey,
} = require('../../../../../common/helpers/transactionalEmail.service');
const {
  resolveVendorInvoiceNotificationRecipients,
  toIdString,
} = require('../../../../../common/helpers/hoaRecipientResolver');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('../../../../../common/helpers/communityEmailContext.service');
const { formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
const { formatMoney } = require('../../../../../common/helpers/invoiceNotificationEmailHelper');
const { ClockService, DateUtil } = require('../../../../../common/date');

function normalizeRecipientId(value) {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function getPortalBaseUrl() {
  return String(
    process.env.HOA_PORTAL_URL ||
      process.env.HOA_FRONTEND_BASE_URL ||
      process.env.FRONTEND_BASE_URL ||
      process.env.APP_URL ||
      'https://app.propmv.com'
  ).replace(/\/$/, '');
}

function invoiceDisplay(invoice = {}) {
  return invoice.title || invoice.invoiceNumber || 'Vendor invoice';
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function resolveVendorPayeeId(invoice = {}) {
  return toIdString(
    invoice?.vendorId && invoice.vendorId._id ? invoice.vendorId._id : invoice?.vendorId
  );
}

function isValidUserObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;
}

/**
 * Board/assignee audience (actor excluded) plus vendor payee always included.
 */
async function resolvePaymentEmailRecipientIds(invoice, actorUserId = null) {
  const boardAndAssignee = await resolveVendorInvoiceNotificationRecipients(invoice, actorUserId);
  const vendorPayeeId = resolveVendorPayeeId(invoice);
  const ids = new Set(
    boardAndAssignee
      .map(normalizeRecipientId)
      .filter(isValidUserObjectId)
  );
  if (vendorPayeeId && isValidUserObjectId(vendorPayeeId)) {
    ids.add(vendorPayeeId);
  }
  return [...ids];
}

function buildPaymentEmailCopy({
  invoice,
  formattedAmount,
  formattedBalance,
  isPaymentCompleted,
  isVendorRecipient,
  viewUrl,
}) {
  const title = invoiceDisplay(invoice);
  const invoiceNumber = invoice.invoiceNumber ? String(invoice.invoiceNumber) : '';
  const entityLabel = [invoiceNumber && `#${invoiceNumber}`, title].filter(Boolean).join(' · ');

  if (isVendorRecipient && isPaymentCompleted) {
    const eventMessage = invoiceNumber
      ? `Payment of ${formattedAmount} was completed for your vendor invoice "${title}" (${invoiceNumber}). Remaining balance: ${formattedBalance}.`
      : `Payment of ${formattedAmount} was completed for your vendor invoice "${title}". Remaining balance: ${formattedBalance}.`;
    const baseSubject = invoiceNumber
      ? `${invoiceNumber} - Payment completed: ${title}`
      : `Payment completed: ${title}`;
    return {
      eventMessage: `${eventMessage} View: ${viewUrl}`,
      preheaderText: eventMessage,
      baseSubject,
      entityLabel: entityLabel || title,
      eventKeySuffix: 'vendor_invoice_payment_completed',
    };
  }

  if (isVendorRecipient) {
    const eventMessage = invoiceNumber
      ? `A partial payment of ${formattedAmount} was recorded for your vendor invoice "${title}" (${invoiceNumber}). Remaining balance: ${formattedBalance}.`
      : `A partial payment of ${formattedAmount} was recorded for your vendor invoice "${title}". Remaining balance: ${formattedBalance}.`;
    const baseSubject = invoiceNumber
      ? `${invoiceNumber} - Partial payment recorded: ${title}`
      : `Partial payment recorded: ${title}`;
    return {
      eventMessage: `${eventMessage} View: ${viewUrl}`,
      preheaderText: eventMessage,
      baseSubject,
      entityLabel: entityLabel || title,
      eventKeySuffix: 'vendor_invoice_payment_partial',
    };
  }

  const paymentKind = isPaymentCompleted ? 'payment' : 'partial payment';
  const eventMessage = invoiceNumber
    ? `A ${paymentKind} of ${formattedAmount} was recorded for vendor invoice "${title}" (${invoiceNumber}). Remaining balance: ${formattedBalance}.`
    : `A ${paymentKind} of ${formattedAmount} was recorded for vendor invoice "${title}". Remaining balance: ${formattedBalance}.`;
  const baseSubject = invoiceNumber
    ? `${invoiceNumber} - Payment recorded: ${title}`
    : `Payment recorded: ${title}`;
  return {
    eventMessage: `${eventMessage} View: ${viewUrl}`,
    preheaderText: eventMessage,
    baseSubject,
    entityLabel: entityLabel || title,
    eventKeySuffix: 'vendor_invoice_payment_recorded',
  };
}

/**
 * Send payment emails for a vendor invoice payment delta (partial or full).
 * Vendor payee is always included.
 */
async function sendVendorInvoicePaymentEmails({
  invoice,
  paymentAmount,
  paymentMethod = 'Payment',
  balanceAfter = null,
  actorUserId = null,
  paidOn = null,
} = {}) {
  const normalizedAmount = roundMoney(paymentAmount);
  if (!invoice || !invoice._id || !(normalizedAmount > 0)) {
    return { attempted: 0, sent: 0, failed: 0, vendorNotified: false };
  }

  const vendorPayeeId = resolveVendorPayeeId(invoice);
  const recipientIds = await resolvePaymentEmailRecipientIds(invoice, actorUserId);
  if (recipientIds.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, vendorNotified: false };
  }

  const users = await User.find({
    _id: { $in: recipientIds.map((id) => new mongoose.Types.ObjectId(id)) },
    isDeleted: { $ne: true },
  })
    .select('_id firstName lastName email')
    .lean();

  const actorIdStr = actorUserId ? String(actorUserId) : null;
  // Exclude actor from board/assignee noise, but never drop the vendor payee.
  const recipients = users.filter((u) => {
    if (!u.email) return false;
    const idStr = String(u._id);
    if (vendorPayeeId && idStr === vendorPayeeId) return true;
    if (actorIdStr && idStr === actorIdStr) return false;
    return true;
  });
  if (recipients.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, vendorNotified: false };
  }

  const hoaId = toIdString(invoice.hoaId) || null;
  const communityName = await resolveCommunityName(hoaId, null);
  const remaining = balanceAfter != null
    ? roundMoney(balanceAfter)
    : roundMoney(invoice.balanceDue);
  const isPaymentCompleted = remaining <= 0;
  const formattedAmount = formatMoney(normalizedAmount);
  const formattedBalance = formatMoney(remaining);
  const methodLabel = String(paymentMethod || 'Payment').trim() || 'Payment';
  const dateKey = formatDateInAppTimezone(ClockService.now()) || DateUtil.toDateOnlyISO(ClockService.now());
  const paidOnKey = paidOn ? String(paidOn).slice(0, 10) : dateKey;
  const invoiceId = toIdString(invoice._id);
  const boardViewUrl = `${getPortalBaseUrl()}/vendor-invoices/${encodeURIComponent(invoiceId)}`;
  const vendorViewUrl = `${getPortalBaseUrl()}/vendor/payment-history/${encodeURIComponent(invoiceId)}`;

  let sent = 0;
  let failed = 0;
  let vendorNotified = false;

  for (const user of recipients) {
    const recipientId = String(user._id);
    const isVendorRecipient = Boolean(vendorPayeeId && recipientId === vendorPayeeId);
    const viewUrl = isVendorRecipient ? vendorViewUrl : boardViewUrl;
    const copy = buildPaymentEmailCopy({
      invoice,
      formattedAmount,
      formattedBalance,
      isPaymentCompleted,
      isVendorRecipient,
      viewUrl,
    });
    const recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
    const subject = buildCommunityEmailSubject(copy.baseSubject, communityName);
    const dedupeEventKey = buildEventKey(
      copy.eventKeySuffix,
      invoiceId,
      user.email,
      paidOnKey,
      String(normalizedAmount),
      String(remaining)
    );

    try {
      const result = await sendTransactionalEmail({
        eventKey: dedupeEventKey,
        type: 'action-update',
        toEmail: user.email,
        data: {
          recipientName,
          eventMessage: copy.eventMessage,
          entityLabel: copy.entityLabel,
        },
        options: {
          template: 'action-update',
          subject,
          preheaderText: copy.preheaderText,
          hoaId,
          communityName: communityName || null,
        },
        entityType: 'VendorInvoice',
        entityId: invoiceId,
        metadata: {
          eventKey: copy.eventKeySuffix,
          paymentAmount: normalizedAmount,
          balanceAfter: remaining,
          paymentMethod: methodLabel,
          isPartial: !isPaymentCompleted,
          isPaymentCompleted,
          audience: isVendorRecipient ? 'vendor' : 'board_or_assignee',
        },
      });
      if (result.sent) {
        sent += 1;
        if (isVendorRecipient) vendorNotified = true;
      }
    } catch (err) {
      failed += 1;
      logger.error('[vendorInvoicePaymentEmail] send failed', {
        to: user.email,
        invoiceId,
        audience: isVendorRecipient ? 'vendor' : 'board_or_assignee',
        error: err.message,
      });
    }
  }

  if (vendorPayeeId && !vendorNotified) {
    logger.warn('[vendorInvoicePaymentEmail] vendor payee was not emailed', {
      invoiceId,
      vendorPayeeId,
      attempted: recipients.length,
      sent,
      failed,
    });
  }

  return { attempted: recipients.length, sent, failed, vendorNotified };
}

function notifyVendorInvoicePaymentEmailInBackground({
  invoice,
  paymentAmount,
  paymentMethod,
  balanceAfter,
  actorUserId = null,
  paidOn = null,
} = {}) {
  setImmediate(() => {
    sendVendorInvoicePaymentEmails({
      invoice,
      paymentAmount,
      paymentMethod,
      balanceAfter,
      actorUserId,
      paidOn,
    }).catch((err) => {
      logger.error('[vendorInvoicePaymentEmail] background send failed', err?.message || err);
    });
  });
}

module.exports = {
  sendVendorInvoicePaymentEmails,
  notifyVendorInvoicePaymentEmailInBackground,
  resolvePaymentEmailRecipientIds,
  buildPaymentEmailCopy,
  resolveVendorPayeeId,
};
