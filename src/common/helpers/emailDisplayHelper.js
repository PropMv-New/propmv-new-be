'use strict';

/** User-friendly labels for MFA / verification email copy. */
function formatMfaActionLabel(action = 'login') {
  const key = String(action || 'login').trim().toLowerCase();
  if (key === 'signup') return 'your account setup';
  if (key === 'forgot-password' || key === 'password-reset') return 'your password reset';
  return 'sign-in';
}

function formatMaintenanceStatusLabel(status) {
  const raw = String(status || '').trim();
  if (!raw) return 'Open';
  const key = raw.toLowerCase().replace(/[\s_-]+/g, '');
  const labels = {
    open: 'Open',
    submitted: 'Submitted',
    inprogress: 'In progress',
    completed: 'Completed',
    resolved: 'Resolved',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
  };
  if (labels[key]) return labels[key];
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMaintenancePriorityLabel(priority) {
  const raw = String(priority || '').trim();
  if (!raw) return 'Medium';
  const key = raw.toLowerCase();
  const labels = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    emergency: 'Emergency',
    urgent: 'Urgent',
  };
  return labels[key] || raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function buildPaymentReminderPreheader({ invoiceNumber, outstandingBalance, dueDate } = {}) {
  const number = invoiceNumber || 'N/A';
  const amount = outstandingBalance || '';
  const due = dueDate || 'soon';
  return `Invoice #${number}${amount ? ` - ${amount}` : ''} due ${due}.`;
}

function buildInvoiceEmailPreheader(params = {}) {
  return buildPaymentReminderPreheader(params);
}

function buildInvoiceUpdatedPreheader({ invoiceNumber, amountDue, dueDate, changeSummary } = {}) {
  const number = invoiceNumber || 'N/A';
  const change = String(changeSummary || '').trim();
  if (change) {
    return `Invoice #${number} updated. ${change}`;
  }
  const amount = amountDue || '';
  const due = dueDate || 'soon';
  return `Invoice #${number} was updated${amount ? ` - ${amount}` : ''} due ${due}.`;
}

function buildInvoiceOverduePreheader({ invoiceNumber, daysOverdue } = {}) {
  const number = invoiceNumber || 'N/A';
  const days = daysOverdue ? `${daysOverdue} days` : '';
  return days
    ? `Invoice #${number} is ${days} overdue. Please pay as soon as possible.`
    : `Invoice #${number} is overdue. Please pay as soon as possible.`;
}

function buildNoteReminderPreheader({ noteTitle, reminderAt } = {}) {
  const title = String(noteTitle || 'Note').trim();
  const when = String(reminderAt || '').trim();
  return when ? `Reminder for "${title}" on ${when}.` : `Reminder for "${title}".`;
}

function buildMaintenanceTicketPreheader({ eventMessage, ticketTitle } = {}) {
  const message = String(eventMessage || '').trim();
  if (message) return message;
  const title = String(ticketTitle || 'Maintenance request').trim();
  return `Update for maintenance ticket: ${title}.`;
}

function buildScreeningApplicationPreheader({ landlordName, propertyName } = {}) {
  const landlord = String(landlordName || 'Your landlord').trim();
  const property = String(propertyName || 'a rental property').trim();
  return `${landlord} invited you to complete tenant screening for ${property}.`;
}

function buildApplicationApprovedPreheader({ propertyName } = {}) {
  const property = String(propertyName || 'the property').trim();
  return `Your rental application for ${property} has been approved.`;
}

function buildUnitAssignmentPreheader({ unitName, propertyName } = {}) {
  const unit = String(unitName || 'A unit').trim();
  const property = String(propertyName || '').trim();
  return property
    ? `${unit} at ${property} has been assigned to your account.`
    : `${unit} has been assigned to your account.`;
}

const INVOICE_DETAIL_LINE_RE =
  /^(Invoice\s*#|Property|Unit|Description|Invoice Amount|Outstanding Balance|Amount Due|Due Date|Status)\s*:/i;
const STANDALONE_GREETING_RE = /^(hi|hello|hey)\s+[^,\n]{1,80},?\s*$/i;
const LEADING_GREETING_RE = /^(hi|hello|hey)\s+[^,\n]{1,80},\s*/i;
const DUPLICATE_PAY_CTA_RE =
  /you can pay (directly )?using the pay (now|invoice) button(?: in this email)?/i;
const DUPLICATE_ALREADY_PAID_RE =
  /if you have already (completed your payment|paid),?\s*please ignore this (message|reminder)/i;

/**
 * Strip greeting, invoice field dump, and CTA copy that the payment-reminder
 * HTML template already renders, so custom dialog bodies do not duplicate them.
 */
function sanitizePaymentReminderCustomMessage(emailBody) {
  if (typeof emailBody !== 'string') return '';

  const lines = emailBody.replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let seenContent = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (!trimmed) {
      if (seenContent && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }

    if (INVOICE_DETAIL_LINE_RE.test(trimmed)) continue;
    if (DUPLICATE_PAY_CTA_RE.test(trimmed)) continue;
    if (DUPLICATE_ALREADY_PAID_RE.test(trimmed)) continue;

    let line = trimmed;
    if (!seenContent) {
      if (STANDALONE_GREETING_RE.test(line)) continue;
      if (LEADING_GREETING_RE.test(line)) {
        line = line.replace(LEADING_GREETING_RE, '').trim();
        if (!line) continue;
      }
    }

    kept.push(line);
    seenContent = true;
  }

  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n').trim();
}

module.exports = {
  formatMfaActionLabel,
  formatMaintenanceStatusLabel,
  formatMaintenancePriorityLabel,
  buildPaymentReminderPreheader,
  buildInvoiceEmailPreheader,
  buildInvoiceUpdatedPreheader,
  buildInvoiceOverduePreheader,
  buildNoteReminderPreheader,
  buildMaintenanceTicketPreheader,
  buildScreeningApplicationPreheader,
  buildApplicationApprovedPreheader,
  buildUnitAssignmentPreheader,
  sanitizePaymentReminderCustomMessage,
};
