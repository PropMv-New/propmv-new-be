/**
 * Email recipients when a vendor invoice is created / assigned.
 * Audience matches in-app: board + assignee + vendor (actor excluded).
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

function resolveAssigneeId(invoice = {}) {
  return toIdString(
    invoice?.assignedTo && invoice.assignedTo._id ? invoice.assignedTo._id : invoice?.assignedTo
  );
}

/**
 * Prefer full vendor-invoice audience; always include the assignee so board/owner
 * assignees are emailed even when hoa board resolution is empty.
 */
async function resolveCreatedEmailRecipientIds(invoice, actorUserId = null) {
  const recipients = await resolveVendorInvoiceNotificationRecipients(invoice, actorUserId);
  const ids = new Set(
    recipients
      .map(normalizeRecipientId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24)
  );
  const assigneeId = resolveAssigneeId(invoice);
  const actorIdStr = actorUserId ? String(actorUserId) : null;
  if (
    assigneeId
    && mongoose.Types.ObjectId.isValid(assigneeId)
    && String(assigneeId).length === 24
    && (!actorIdStr || assigneeId !== actorIdStr)
  ) {
    ids.add(assigneeId);
  }
  return [...ids];
}

async function sendVendorInvoiceCreatedEmails({ invoice, actorUserId = null } = {}) {
  if (!invoice || !invoice._id) return { attempted: 0, sent: 0, failed: 0 };

  const validUserIds = await resolveCreatedEmailRecipientIds(invoice, actorUserId);
  if (validUserIds.length === 0) return { attempted: 0, sent: 0, failed: 0 };

  const users = await User.find({
    _id: { $in: validUserIds.map((id) => new mongoose.Types.ObjectId(id)) },
    isDeleted: { $ne: true },
  })
    .select('_id firstName lastName email')
    .lean();

  const actorIdStr = actorUserId ? String(actorUserId) : null;
  const recipients = users.filter((u) => (actorIdStr ? String(u._id) !== actorIdStr : true) && !!u.email);

  const hoaId = toIdString(invoice.hoaId) || null;
  const communityName = await resolveCommunityName(hoaId, null);
  const title = invoiceDisplay(invoice);
  const invoiceNumber = invoice.invoiceNumber ? String(invoice.invoiceNumber) : '';
  const amountLabel = formatMoney(invoice.subAmount ?? invoice.balanceDue ?? 0);
  const assigneeId = resolveAssigneeId(invoice);
  const eventMessageBase = invoiceNumber
    ? `Vendor invoice "${title}" (${invoiceNumber}) for ${amountLabel} has been created and assigned.`
    : `Vendor invoice "${title}" for ${amountLabel} has been created and assigned.`;
  const entityLabel = [invoiceNumber && `#${invoiceNumber}`, title].filter(Boolean).join(' · ');
  const baseSubject = invoiceNumber
    ? `${invoiceNumber} - Vendor invoice assigned: ${title}`
    : `Vendor invoice assigned: ${title}`;
  const subject = buildCommunityEmailSubject(baseSubject, communityName);
  const dateKey = formatDateInAppTimezone(ClockService.now()) || DateUtil.toDateOnlyISO(ClockService.now());
  const invoiceId = toIdString(invoice._id);
  const viewUrl = `${getPortalBaseUrl()}/vendor-invoices/${encodeURIComponent(invoiceId)}`;

  let sent = 0;
  let failed = 0;

  for (const user of recipients) {
    const recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
    const isAssignee = assigneeId && String(user._id) === assigneeId;
    const eventMessage = isAssignee
      ? `${eventMessageBase} It was assigned to you. View: ${viewUrl}`
      : `${eventMessageBase} View: ${viewUrl}`;
    const dedupeEventKey = buildEventKey(
      'vendor_invoice_created_email',
      invoiceId,
      user.email,
      dateKey
    );

    try {
      const result = await sendTransactionalEmail({
        eventKey: dedupeEventKey,
        type: 'action-update',
        toEmail: user.email,
        data: {
          recipientName,
          eventMessage,
          entityLabel: entityLabel || title,
        },
        options: {
          template: 'action-update',
          subject,
          preheaderText: eventMessageBase,
          hoaId,
          communityName: communityName || null,
        },
        entityType: 'VendorInvoice',
        entityId: invoiceId,
        metadata: { eventKey: 'vendor_invoice_created' },
      });
      if (result.sent) sent += 1;
    } catch (err) {
      failed += 1;
      logger.error('[vendorInvoiceCreatedEmail] send failed', {
        to: user.email,
        invoiceId,
        error: err.message,
      });
    }
  }

  return { attempted: recipients.length, sent, failed };
}

function notifyVendorInvoiceCreatedEmailInBackground(invoice, actorUserId = null) {
  setImmediate(() => {
    sendVendorInvoiceCreatedEmails({ invoice, actorUserId }).catch((err) => {
      logger.error('[vendorInvoiceCreatedEmail] background send failed', err?.message || err);
    });
  });
}

module.exports = {
  sendVendorInvoiceCreatedEmails,
  notifyVendorInvoiceCreatedEmailInBackground,
  resolveCreatedEmailRecipientIds,
};
