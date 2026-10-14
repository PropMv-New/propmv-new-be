/**
 * Email recipients when a comment/note is added on a vendor invoice.
 * Audience matches in-app: board + assignee + vendor (actor excluded).
 */

const mongoose = require('mongoose');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');
const {
  sendTransactionalEmail,
  buildEventKey,
} = require('../../../../../common/helpers/transactionalEmail.service');
const { resolveVendorInvoiceNotificationRecipients, toIdString } = require('../../../../../common/helpers/hoaRecipientResolver');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('../../../../../common/helpers/communityEmailContext.service');
const { formatDateInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
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

async function sendVendorInvoiceCommentEmails({ invoice, actorUserId = null } = {}) {
  if (!invoice || !invoice._id) return { attempted: 0, sent: 0, failed: 0 };

  const recipientIds = await resolveVendorInvoiceNotificationRecipients(invoice, actorUserId);
  const validUserIds = [...new Set(
    recipientIds
      .map(normalizeRecipientId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id) && String(id).length === 24)
  )];
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
  const eventMessage = invoiceNumber
    ? `A comment was added to vendor invoice "${title}" (${invoiceNumber}).`
    : `A comment was added to vendor invoice "${title}".`;
  const entityLabel = [invoiceNumber && `#${invoiceNumber}`, title].filter(Boolean).join(' · ');
  const baseSubject = invoiceNumber
    ? `${invoiceNumber} - Comment added: ${title}`
    : `Comment added: ${title}`;
  const subject = buildCommunityEmailSubject(baseSubject, communityName);
  const dateKey = formatDateInAppTimezone(ClockService.now()) || DateUtil.toDateOnlyISO(ClockService.now());
  const invoiceId = toIdString(invoice._id);
  const viewUrl = `${getPortalBaseUrl()}/vendor-invoices/${encodeURIComponent(invoiceId)}`;

  let sent = 0;
  let failed = 0;

  for (const user of recipients) {
    const recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
    const dedupeEventKey = buildEventKey(
      'vendor_invoice_comment_email',
      invoiceId,
      (invoice.comments || []).length,
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
          eventMessage: `${eventMessage} View: ${viewUrl}`,
          entityLabel: entityLabel || title,
        },
        options: {
          template: 'action-update',
          subject,
          preheaderText: eventMessage,
          hoaId,
          communityName: communityName || null,
        },
        entityType: 'VendorInvoice',
        entityId: invoiceId,
        metadata: { eventKey: 'vendor_invoice_comment_added' },
      });
      if (result.sent) sent += 1;
    } catch (err) {
      failed += 1;
      logger.error('[vendorInvoiceCommentEmail] send failed', {
        to: user.email,
        invoiceId,
        error: err.message,
      });
    }
  }

  return { attempted: recipients.length, sent, failed };
}

function notifyVendorInvoiceCommentEmailInBackground(invoice, actorUserId = null) {
  setImmediate(() => {
    sendVendorInvoiceCommentEmails({ invoice, actorUserId }).catch((err) => {
      logger.error('[vendorInvoiceCommentEmail] background send failed', err?.message || err);
    });
  });
}

module.exports = {
  sendVendorInvoiceCommentEmails,
  notifyVendorInvoiceCommentEmailInBackground,
};
