/**
 * ------------------------------------------------------------------
 * File: invoiceNotificationEmailHelper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoiceNotificationEmailHelper.
 *
 * Used By:
 * invoiceLifecycleEmail.service, invoice.service, unitLateFee.service
 * ------------------------------------------------------------------
 */
const emailHelper = require('./emailHelper');
const Invoice = require('../../portals/hoa-board/modules/invoice/model/invoice.model');
const Property = require('../../portals/hoa-board/modules/property/model/property.model');
const User = require('../../shared/modules/users/models/user.model');
const { formatEmailDate } = require('./hoaBillingDates');
const logger = require('../logger');
const { ClockService } = require('../date');
const {
  resolveCommunityName,
  buildCommunityEmailSubject,
} = require('./communityEmailContext.service');
const { resolveInvoiceUnitNumber } = require('../../portals/hoa-board/modules/invoice/helpers/invoiceUnitFilter.helper');
const { enqueueOrRunInBackground } = require('../jobs/enqueue');
const { JOB_TYPES } = require('../jobs/constants');
const { buildJobIdempotencyKey } = require('../jobs/idempotency');

const roundCurrency = (value) => Number((Number(value) || 0).toFixed(2));

/**
 * format Money
 *
 * Performs logic operations for formatMoney.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function formatMoney(value) {
  return `$${roundCurrency(value).toFixed(2)}`;
}

/**
 * get Portal Base Url
 *
 * Performs logic operations for getPortalBaseUrl.
 *
 * @returns Operations result
 */
function getPortalBaseUrl() {
  return String(
    process.env.HOA_FRONTEND_BASE_URL ||
    process.env.INVOICE_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.APP_URL ||
    'https://app.propmv.com'
  ).replace(/\/$/, '');
}

function formatAddressForDisplay(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  if (typeof address !== 'object') return '';

  const street = address.street || address.line1 || address.addressLine1;
  const line2 = address.line2 || address.addressLine2;
  const city = address.city;
  const state = address.state;
  const zip = address.zip || address.zipCode || address.postalCode;
  const country = address.country;
  const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  return [street, line2, cityStateZip, country].filter(Boolean).join(', ').trim();
}

/**
 * build Invoice Portal Urls
 *
 * Performs logic operations for buildInvoicePortalUrls.
 *
 * @param invoiceObjectId - Request/input argument
 * @returns Operations result
 */
function buildInvoicePortalUrls(invoiceObjectId) {
  const base = getPortalBaseUrl();
  const id = encodeURIComponent(String(invoiceObjectId));
  const ownerInvoicesPath = `${base}/invoices`;
  return {
    paymentUrl: `${ownerInvoicesPath}/${id}`,
    viewInvoiceUrl: `${ownerInvoicesPath}/${id}`,
  };
}

/**
 * recipient Display Name
 *
 * Performs logic operations for recipientDisplayName.
 *
 * @param user - Request/input argument
 * @returns Operations result
 */
function recipientDisplayName(user) {
  const name = `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
  return name || user?.email || 'there';
}

async function resolveInvoicePayerUsers(invoice) {
  const tenantRefs = Array.isArray(invoice?.tenants) ? invoice.tenants : [];
  const tenantIds = tenantRefs
    .map((t) => (t && typeof t === 'object' && t._id ? t._id : t))
    .filter(Boolean);

  if (tenantIds.length === 0) return [];

  const populated = tenantRefs.every((t) => t && typeof t === 'object' && t.email);
  if (populated) {
    return tenantRefs.filter((t) => t?.email);
  }

  return User.find({
    _id: { $in: tenantIds },
    isDeleted: { $ne: true },
  })
    .select('email firstName lastName')
    .lean();
}

/**
 * run In Background
 *
 * Performs logic operations for runInBackground.
 *
 * @param task - Request/input argument
 * @returns Operations result
 */
function runInBackground(task) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => logger.error('[InvoiceNotificationEmail]', err.message));
  });
}

/**
 * invoice Has Required Fields
 *
 * Performs logic operations for invoiceHasRequiredFields.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function invoiceHasRequiredFields(invoice) {
  return (
    invoice &&
    invoice._id &&
    Array.isArray(invoice.tenants) &&
    invoice.balanceDue != null &&
    invoice.dueDate != null &&
    invoice.propertyName != null &&
    invoice.unit != null
  );
}

/**
 * Check if all tenants in the invoice are fully populated user objects (have email).
 * If not, the invoice needs to be reloaded from the database to populate tenants.
 */
function tenantsArePopulated(invoice) {
  if (!Array.isArray(invoice?.tenants)) return false;
  return invoice.tenants.every((t) => t && typeof t === 'object' && t.email);
}

const INVOICE_EMAIL_SELECT =
  'invoiceId propertyId propertyName unit tenants balanceDue dueDate subAmount principalSubAmount hoaId';

/**
 * Resolve HOA community branding for invoice emails (from name, subject suffix, template data).
 */
async function resolveInvoiceHoaId(invoiceOrHoaId) {
  if (!invoiceOrHoaId) return null;
  if (typeof invoiceOrHoaId !== 'object') {
    return invoiceOrHoaId;
  }
  if (invoiceOrHoaId.hoaId) return invoiceOrHoaId.hoaId;

  const propertyRef = invoiceOrHoaId.propertyId;
  const propertyId =
    propertyRef && typeof propertyRef === 'object' && propertyRef._id
      ? propertyRef._id
      : propertyRef;
  if (!propertyId) return null;

  const property = await Property.findById(propertyId).select('hoaId').lean();
  return property?.hoaId || null;
}

async function resolveInvoiceEmailBranding(invoiceOrHoaId) {
  const hoaId = await resolveInvoiceHoaId(invoiceOrHoaId);
  const communityNameHint =
    invoiceOrHoaId && typeof invoiceOrHoaId === 'object'
      ? invoiceOrHoaId.communityName || invoiceOrHoaId.hoaName || ''
      : '';
  const communityName = await resolveCommunityName(hoaId, communityNameHint);

  return {
    hoaId: hoaId || null,
    communityName: communityName || null,
    organizationDisplayName: communityName,
  };
}

function buildInvoiceEmailSubject(base, branding) {
  return buildCommunityEmailSubject(
    base,
    branding?.communityName || branding?.organizationDisplayName || ''
  );
}

function mergeInvoiceEmailBranding(data, branding) {
  if (!branding) return data;
  return {
    ...data,
    hoaId: branding.hoaId || data.hoaId || null,
    communityName: branding.communityName || data.communityName || null,
    organizationDisplayName: branding.organizationDisplayName,
  };
}

function buildInvoiceEmailSendOptions(invoice, branding, options = {}) {
  const resolved = branding || { hoaId: invoice?.hoaId || null };
  return {
    ...options,
    hoaId: resolved.hoaId || invoice?.hoaId || null,
    communityName: resolved.communityName || null,
  };
}

async function loadInvoiceForEmail(invoiceOrId, { forceReload = false } = {}) {
  if (!invoiceOrId) return null;

  const invoiceId =
    typeof invoiceOrId === 'string' || typeof invoiceOrId === 'number'
      ? invoiceOrId
      : invoiceOrId._id || invoiceOrId;

  if (!forceReload && typeof invoiceOrId === 'object' && invoiceOrId !== null) {
    if (invoiceHasRequiredFields(invoiceOrId) && tenantsArePopulated(invoiceOrId)) {
      return invoiceOrId;
    }
  }

  return Invoice.findById(invoiceId)
    .select(INVOICE_EMAIL_SELECT)
    .populate('tenants', 'firstName lastName email')
    .populate('propertyId', 'name unitDetails')
    .lean();
}

async function sendPaymentReceivedEmail({
  invoice: invoiceInput,
  paymentAmount,
  paymentMethod = 'Payment',
  balanceAfter = null,
  paidAt = ClockService.now(),
}) {
  const invoice = await loadInvoiceForEmail(invoiceInput);
  if (!invoice) return { sent: 0 };

  const recipients = await resolveInvoicePayerUsers(invoice);
  if (!recipients.length) return { sent: 0 };

  const branding = await resolveInvoiceEmailBranding(invoice);
  const urls = buildInvoicePortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const remainingBalance = balanceAfter != null ? balanceAfter : roundCurrency((invoice.balanceDue || 0) - (paymentAmount || 0));

  const jobs = recipients.map((user) =>
    emailHelper.sendEmail(
      'payment-received',
      user.email,
      mergeInvoiceEmailBranding(
        {
          recipientName: recipientDisplayName(user),
          invoiceNumber,
          paymentAmount: formatMoney(paymentAmount),
          paymentMethod: paymentMethod || 'Payment',
          propertyName: invoice.propertyName || 'N/A',
          unitNumber: resolveInvoiceUnitNumber(invoice),
          remainingBalance: formatMoney(remainingBalance),
          paidOn: formatEmailDate(paidAt),
          ...urls,
        },
        branding
      ),
      buildInvoiceEmailSendOptions(invoice, branding, {
        template: 'payment-received',
        subject: buildInvoiceEmailSubject(`Payment received - Invoice ${invoiceNumber}`, branding),
        preheaderText: `Thank you - we received your payment of ${formatMoney(paymentAmount)} for invoice ${invoiceNumber}.`,
      })
    )
  );

  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { attempted: recipients.length, sent: recipients.length - failed, failed };
}

async function sendPaymentFailedEmail({
  toEmail,
  recipientName = 'there',
  invoice: invoiceInput,
  failureReason = '',
  paymentAmount = null,
  paymentUrl,
  viewInvoiceUrl,
} = {}) {
  const invoice = await loadInvoiceForEmail(invoiceInput);
  if (!invoice && !toEmail) return { sent: 0, attempted: 0 };

  const branding = invoice ? await resolveInvoiceEmailBranding(invoice) : null;
  const urls = invoice ? buildInvoicePortalUrls(invoice._id) : {};
  const invoiceNumber = invoice?.invoiceId || (invoice?._id ? String(invoice._id) : 'N/A');
  const amountDueValue = paymentAmount != null
    ? paymentAmount
    : (invoice?.balanceDue || 0);

  const recipients = [];
  if (toEmail) {
    recipients.push({ email: toEmail, firstName: recipientName });
  } else if (invoice) {
    const payers = await resolveInvoicePayerUsers(invoice);
    for (const payer of payers) {
      if (payer?.email) recipients.push(payer);
    }
  }

  if (!recipients.length) return { sent: 0, attempted: 0 };

  let sent = 0;
  for (const user of recipients) {
    const email = user.email || toEmail;
    if (!email) continue;
    const name = user.firstName != null || user.lastName != null
      ? recipientDisplayName(user)
      : (recipientName || 'there');
    try {
      await emailHelper.sendEmail(
        'payment-failed',
        email,
        mergeInvoiceEmailBranding(
          {
            recipientName: name,
            invoiceNumber,
            propertyName: invoice?.propertyName || 'N/A',
            amountDue: formatMoney(amountDueValue),
            failureReason: failureReason || '',
            paymentUrl: paymentUrl || urls.paymentUrl || getPortalBaseUrl(),
            viewInvoiceUrl: viewInvoiceUrl || urls.viewInvoiceUrl || getPortalBaseUrl(),
          },
          branding
        ),
        buildInvoiceEmailSendOptions(invoice, branding, {
          template: 'payment-failed',
          subject: buildInvoiceEmailSubject(`Payment failed - Invoice ${invoiceNumber}`, branding),
          preheaderText: `Your payment for invoice ${invoiceNumber} could not be processed. Please try again.`,
        })
      );
      sent += 1;
    } catch (err) {
      logger.error('[InvoiceNotificationEmail] payment failed send error:', err?.message || err);
    }
  }

  return { sent, attempted: recipients.length };
}

async function sendLateFeeNotificationEmail({
  invoice: invoiceInput,
  lateFeeAmount,
  lateFeeSequence = 1,
}) {
  const invoice = await loadInvoiceForEmail(invoiceInput);
  if (!invoice) return { sent: 0 };

  const recipients = await resolveInvoicePayerUsers(invoice);
  if (!recipients.length) return { sent: 0 };

  const branding = await resolveInvoiceEmailBranding(invoice);
  const urls = buildInvoicePortalUrls(invoice._id);
  const invoiceNumber = invoice.invoiceId || String(invoice._id);
  const feeLabel = Number(lateFeeSequence) === 1 ? 'Initial late fee' : 'Daily late fee';

  const jobs = recipients.map((user) =>
    emailHelper.sendEmail(
      'late-fee-notification',
      user.email,
      mergeInvoiceEmailBranding(
        {
          recipientName: recipientDisplayName(user),
          invoiceNumber,
          propertyName: invoice.propertyName || 'N/A',
          unitNumber: resolveInvoiceUnitNumber(invoice),
          lateFeeAmount: formatMoney(lateFeeAmount),
          balanceDue: formatMoney(invoice.balanceDue || 0),
          dueDate: invoice.dueDate ? formatEmailDate(invoice.dueDate) : 'N/A',
          lateFeeLabel: feeLabel,
          ...urls,
        },
        branding
      ),
      buildInvoiceEmailSendOptions(invoice, branding, {
        template: 'late-fee-notification',
        subject: buildInvoiceEmailSubject(`Late fee applied - Invoice ${invoiceNumber}`, branding),
        preheaderText: `A late fee was added to invoice ${invoiceNumber}. Please review your updated balance.`,
      })
    )
  );

  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { attempted: recipients.length, sent: recipients.length - failed, failed };
}

/**
 * resolve Payment Notification Payload
 *
 * Performs logic operations for resolvePaymentNotificationPayload.
 *
 * @param options - Request/input argument
 * @param paymentDelta - Request/input argument
 * @returns Operations result
 */
function resolvePaymentNotificationPayload({ invoice, paymentDelta, paymentPrep } = {}) {
  const paymentMeta = paymentPrep?.paymentMeta || null;

  if (paymentDelta?.amount > 0) {
    return {
      invoice,
      paymentAmount: paymentDelta.amount,
      paymentMethod: paymentDelta.method,
      balanceAfter: paymentDelta.balanceAfter,
      paidAt: paymentDelta.paidAt,
      recordedAt: paymentDelta.recordedAt || paymentMeta?.recordedAt || ClockService.now(),
    };
  }
  if (
    ['overpayment', 'chronological'].includes(paymentPrep?.mode)
    && paymentPrep.result?.paymentAmount > 0
  ) {
    return {
      invoice,
      paymentAmount: paymentPrep.result.paymentAmount,
      paymentMethod: paymentMeta?.method || paymentPrep.result.paymentMethod || 'Payment',
      balanceAfter:
        paymentPrep.result.balanceAfter != null
          ? paymentPrep.result.balanceAfter
          : invoice?.balanceDue,
      paidAt: paymentMeta?.paidAt || ClockService.now(),
      recordedAt: paymentMeta?.recordedAt || ClockService.now(),
    };
  }

  return null;
}

/**
 * notify Payment Received In Background
 *
 * Performs logic operations for notifyPaymentReceivedInBackground.
 *
 * @param payload - Request/input argument
 * @returns Operations result
 */
function notifyPaymentReceivedInBackground(payload = {}) {
  const invoiceId = payload.invoice?._id || payload.invoice || payload.invoiceId;
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_PAYMENT_RECEIVED,
    entityType: 'Invoice',
    entityId: invoiceId,
    eventId: payload.paymentTransactionId || '',
    idempotencyKey: buildJobIdempotencyKey(
      'EMAIL_PAYMENT_RECEIVED',
      invoiceId,
      payload.paymentTransactionId || payload.paymentAmount,
      payload.paidAt
    ),
    payload: { ...payload, invoiceId: invoiceId ? String(invoiceId) : '' },
    preferInline: true,
    run: () => sendPaymentReceivedEmail(payload),
  });
}

/**
 * notify Invoice Payment Received In Background
 *
 * Performs logic operations for notifyInvoicePaymentReceivedInBackground.
 *
 * @param options - Request/input argument
 * @param paymentDelta - Request/input argument
 * @returns Operations result
 */
function notifyInvoicePaymentReceivedInBackground({ invoice, paymentDelta, paymentPrep } = {}) {
  const payload = resolvePaymentNotificationPayload({ invoice, paymentDelta, paymentPrep });
  if (!payload) return;
  notifyPaymentReceivedInBackground(payload);
}

/**
 * notify Payment Failed In Background
 *
 * Performs logic operations for notifyPaymentFailedInBackground.
 *
 * @param payload - Request/input argument
 * @returns Operations result
 */
function notifyPaymentFailedInBackground(payload = {}) {
  const invoiceId = payload.invoice?._id || payload.invoice || payload.invoiceId;
  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_PAYMENT_FAILED,
    entityType: 'Invoice',
    entityId: invoiceId,
    eventId: payload.paymentTransactionId || '',
    idempotencyKey: buildJobIdempotencyKey(
      'EMAIL_PAYMENT_FAILED',
      invoiceId,
      payload.paymentTransactionId || payload.paymentAmount,
      payload.failedAt || payload.occurredAt
    ),
    payload: { ...payload, invoiceId: invoiceId ? String(invoiceId) : '' },
    preferInline: true,
    run: () => sendPaymentFailedEmail(payload),
  });
}

/**
 * notify Late Fee Applied In Background
 *
 * Performs logic operations for notifyLateFeeAppliedInBackground.
 *
 * @param options - Request/input argument
 * @param amount - Request/input argument
 * @param lateFeeSequence - Request/input argument
 * @returns Operations result
 */
function notifyLateFeeAppliedInBackground({ invoiceId, amount, lateFeeSequence = 1 } = {}) {
  if (!invoiceId || !amount) return;

  const { automatedNotificationSchedule } = require('../../config/automatedNotificationSchedule.config');
  const { getNextLateFeeNotificationRunAt } = require('../schedulers/scheduledRunTime.helper');
  const { isBackgroundJobsEnabled } = require('../jobs/config');

  const scheduledAt =
    automatedNotificationSchedule.lateFee?.enabled && isBackgroundJobsEnabled()
      ? getNextLateFeeNotificationRunAt()
      : undefined;

  enqueueOrRunInBackground({
    jobType: JOB_TYPES.EMAIL_LATE_FEE_APPLIED,
    entityType: 'Invoice',
    entityId: invoiceId,
    idempotencyKey: buildJobIdempotencyKey('EMAIL_LATE_FEE_APPLIED', invoiceId, amount, lateFeeSequence),
    payload: { invoiceId: String(invoiceId), amount, lateFeeSequence },
    scheduledAt,
    run: async () => {
      const invoice = await loadInvoiceForEmail(invoiceId);
      if (!invoice) return;
      await sendLateFeeNotificationEmail({
        invoice,
        lateFeeAmount: amount,
        lateFeeSequence,
      });
    },
  });
}

module.exports = {
  sendPaymentReceivedEmail,
  sendPaymentFailedEmail,
  sendLateFeeNotificationEmail,
  notifyPaymentReceivedInBackground,
  notifyInvoicePaymentReceivedInBackground,
  resolvePaymentNotificationPayload,
  notifyPaymentFailedInBackground,
  notifyLateFeeAppliedInBackground,
  loadInvoiceForEmail,
  buildInvoicePortalUrls,
  getPortalBaseUrl,
  formatAddressForDisplay,
  formatMoney,
  recipientDisplayName,
  resolveInvoicePayerUsers,
  resolveInvoiceEmailBranding,
  buildInvoiceEmailSubject,
  mergeInvoiceEmailBranding,
  buildInvoiceEmailSendOptions,
  resolveInvoiceUnitNumber,
};
