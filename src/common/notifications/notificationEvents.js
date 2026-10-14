/**
 * ------------------------------------------------------------------
 * File: notificationEvents.js
 * Module: Src Common Notifications
 *
 * Purpose:
 * Backend utility/module providing helper functions for notificationEvents.
 *
 * Used By:
 * notifications
 * ------------------------------------------------------------------
 */

/**
 * Central registry of all notification events.
 *
 * Each event defines:
 *   type     - stored in DB, used for routing/icons on the frontend
 *   priority - low | medium | high | critical
 *   title    - heading shown in the notification
 *   message  - fn(data) that builds the notification body from event data
 */

const EVENTS = {

  // ── Property ─────────────────────────────────────────────────────────────────
  PROPERTY_CREATED: {
    type: 'property_created',
    priority: 'medium',
    title: 'Property Created',
    message: (d) => `A new property "${d.propertyName}" has been created.`,
  },
  PROPERTY_UPDATED: {
    type: 'property_updated',
    priority: 'low',
    title: 'Property Updated',
    message: (d) => `Property "${d.propertyName}" has been updated.`,
  },
  PROPERTY_DELETED: {
    type: 'property_deleted',
    priority: 'high',
    title: 'Property Deleted',
    message: (d) => `Property "${d.propertyName}" has been deleted.`,
  },

  // ── Owner ─────────────────────────────────────────────────────────────────────
  OWNER_CREATED: {
    type: 'owner_created',
    priority: 'medium',
    title: 'Owner Added',
    message: (d) => `Owner "${d.ownerName}" has been added to the community.`,
  },
  OWNER_UPDATED: {
    type: 'owner_updated',
    priority: 'low',
    title: 'Owner Updated',
    message: (d) => `Owner "${d.ownerName}" profile has been updated.`,
  },
  OWNER_ARCHIVED: {
    type: 'owner_archived',
    priority: 'medium',
    title: 'Owner Archived',
    message: (d) => `Owner "${d.ownerName}" has been archived.`,
  },
  OWNER_DELETED: {
    type: 'owner_deleted',
    priority: 'high',
    title: 'Owner Removed',
    message: (d) =>
      d.unitName
        ? `Owner "${d.ownerName}" has been removed from unit "${d.unitName}".`
        : `Owner "${d.ownerName}" has been removed from the community.`,
  },

  // ── Lease ─────────────────────────────────────────────────────────────────────
  LEASE_CREATED: {
    type: 'lease_created',
    priority: 'medium',
    title: 'Lease Created',
    message: (d) => `A new lease has been created for unit "${d.unitName}" at "${d.propertyName}".`,
  },
  LEASE_UPDATED: {
    type: 'lease_updated',
    priority: 'low',
    title: 'Lease Updated',
    message: (d) => `Your lease for unit "${d.unitName}" at "${d.propertyName}" has been updated.`,
  },
  LEASE_EXPIRING_SOON: {
    type: 'lease_expiry',
    priority: 'high',
    title: 'Lease Expiring Soon',
    message: (d) => `Your lease for unit "${d.unitName}" at "${d.propertyName}" expires in ${d.daysRemaining} days.`,
  },
  LEASE_EXPIRED: {
    type: 'lease_expired',
    priority: 'high',
    title: 'Lease Expired',
    message: (d) => `The lease for unit "${d.unitName}" at "${d.propertyName}" has expired.`,
  },
  LEASE_TERMINATED: {
    type: 'lease_terminated',
    priority: 'high',
    title: 'Lease Terminated',
    message: (d) => `The lease for unit "${d.unitName}" at "${d.propertyName}" has been terminated.`,
  },
  LEASE_INVITE_ACKNOWLEDGED: {
    type: 'lease_updated',
    priority: 'medium',
    title: 'Lease Invite Acknowledged',
    message: (d) =>
      `${d.tenantName} has acknowledged their lease invite for unit "${d.unitName}" at "${d.propertyName}".`,
  },

  // ── Maintenance ───────────────────────────────────────────────────────────────
  MAINTENANCE_REQUEST_CREATED: {
    type: 'maintenance_request',
    priority: 'medium',
    title: 'Maintenance Request Submitted',
    message: (d) =>
      d.customMessage
      || `A maintenance request "${d.title}" has been submitted for unit "${d.unitName || 'Unit'}".`,
  },
  MAINTENANCE_REQUEST_UPDATED: {
    type: 'maintenance_request',
    priority: 'low',
    title: 'Maintenance Request Updated',
    message: (d) =>
      d.customMessage
      || (d.status
        ? `Maintenance request "${d.title}" has been updated to status "${d.status}".`
        : `Maintenance request "${d.title}" has been updated.`),
  },
  MAINTENANCE_REQUEST_COMPLETED: {
    type: 'maintenance_request',
    priority: 'medium',
    // Align with resolve email ("Maintenance resolved" / "marked as resolved"),
    // including when vendors close a ticket as Completed.
    title: 'Maintenance Request Resolved',
    message: (d) =>
      d.customMessage
      || `Maintenance request "${d.title}" for unit "${d.unitName || 'Unit'}" has been marked as resolved.`,
  },
  MAINTENANCE_REQUEST_REOPENED: {
    type: 'maintenance_request',
    priority: 'medium',
    title: 'Maintenance Ticket Reopened',
    message: (d) =>
      d.customMessage
      || `Maintenance ticket "${d.title}" for unit "${d.unitName || 'Unit'}" has been reopened.`,
  },
  MAINTENANCE_VENDOR_ASSIGNED: {
    type: 'maintenance_request',
    priority: 'medium',
    title: 'Vendor Assigned',
    message: (d) =>
      d.customMessage
      || `A vendor has been assigned to maintenance ticket "${d.title}" for unit "${d.unitName || 'Unit'}".`,
  },
  MAINTENANCE_COMMENT_ADDED: {
    type: 'maintenance_request',
    priority: 'low',
    title: 'Maintenance Comment Added',
    message: (d) =>
      d.customMessage
      || `A comment was added to maintenance request "${d.title}".`,
  },
  MAINTENANCE_NOTE_ADDED: {
    type: 'maintenance_request',
    priority: 'low',
    title: 'Maintenance Note Added',
    message: (d) =>
      d.customMessage
      || `A note was added to maintenance request "${d.title}".`,
  },
  MAINTENANCE_DOCUMENTS_UPDATED: {
    type: 'maintenance_request',
    priority: 'low',
    title: 'Maintenance Documents Updated',
    message: (d) =>
      d.customMessage
      || `Documents were updated on maintenance request "${d.title}".`,
  },

  // ── HOA Documents / Expenses ──────────────────────────────────────────────────
  DOCUMENT_UPLOADED: {
    type: 'document_uploaded',
    priority: 'medium',
    title: 'New Document Uploaded',
    message: (d) =>
      d.customMessage
      || `A new document "${d.documentName}" was uploaded${d.accessLevel ? ` (${d.accessLevel})` : ''}.`,
  },
  EXPENSE_CREATED: {
    type: 'expense_created',
    priority: 'medium',
    title: 'Expense Created',
    message: (d) =>
      d.customMessage
      || `An expense of $${d.amount} for "${d.vendorName}" has been created.`,
  },
  EXPENSE_UPDATED: {
    type: 'expense_updated',
    priority: 'low',
    title: 'Expense Updated',
    message: (d) =>
      d.customMessage
      || `Expense for "${d.vendorName}"${d.amount ? ` ($${d.amount})` : ''} has been updated.`,
  },
  EXPENSE_PAID: {
    type: 'expense_paid',
    priority: 'medium',
    title: 'Expense Marked Paid',
    message: (d) =>
      d.customMessage
      || `Expense for "${d.vendorName}"${d.amount ? ` ($${d.amount})` : ''} has been marked as paid.`,
  },
  EXPENSE_DELETED: {
    type: 'expense_deleted',
    priority: 'high',
    title: 'Expense Deleted',
    message: (d) =>
      d.customMessage
      || `Expense for "${d.vendorName}"${d.amount ? ` ($${d.amount})` : ''} has been deleted.`,
  },

  // ── Payment / Invoice ─────────────────────────────────────────────────────────
  PAYMENT_RECEIVED: {
    type: 'payment_received',
    priority: 'medium',
    title: 'Payment Received',
    message: (d) => `Payment of $${d.amount} has been received for unit "${d.unitName}".`,
  },
  PAYMENT_DELETED: {
    type: 'payment_deleted',
    priority: 'medium',
    title: 'Payment Removed',
    message: (d) => `A payment of $${d.amount} has been removed for unit "${d.unitName}".`,
  },
  PAYMENT_FAILED: {
    type: 'payment_failed',
    priority: 'high',
    title: 'Payment Failed',
    message: (d) =>
      d.customMessage
      || `A payment of $${d.amount} for unit "${d.unitName}" could not be processed.`,
  },
  PAYMENT_PROCESSING: {
    type: 'payment_processing',
    priority: 'medium',
    title: 'Payment Processing',
    message: (d) =>
      d.customMessage
      || `A payment of $${d.amount} for unit "${d.unitName}" is being processed.`,
  },
  PAYMENT_OVERDUE: {
    type: 'payment_overdue',
    priority: 'high',
    title: 'Payment Overdue',
    message: (d) => `Rent payment of $${d.amount} for unit "${d.unitName}" is overdue by ${d.daysOverdue} days.`,
  },
  INVOICE_CREATED: {
    type: 'invoice_created',
    priority: 'medium',
    title: 'Invoice Created',
    message: (d) => `A new invoice of $${d.amount} has been created for unit "${d.unitName}".`,
  },
  NEXT_YEAR_INVOICES_CREATED_OWNER: {
    type: 'next_year_invoices_created',
    priority: 'high',
    title: 'Next-Year Invoice Created',
    message: (d) => {
      const year = d.billingYear || 'the upcoming billing year';
      if (Number(d.invoiceCount) > 1) {
        return `Your invoices for ${year} have been created automatically in advance. Please review the invoice details and payment schedule.`;
      }
      return `Your invoice for the upcoming billing year (${year}) has been created automatically in advance. Please review the invoice details and payment schedule.`;
    },
  },
  NEXT_YEAR_INVOICES_CREATED_BOARD: {
    type: 'next_year_invoices_created_board',
    priority: 'high',
    title: 'Next-Year HOA Invoices Created',
    message: (d) => {
      const year = d.billingYear || 'the upcoming billing year';
      const count = Number(d.invoiceCount) || 1;
      return `Next-year invoices have been automatically generated for ${count} HOA owner invoice${count === 1 ? '' : 's'} (${year}). Please review the upcoming invoices.`;
    },
  },
  INVOICE_UPDATED: {
    type: 'invoice_updated',
    priority: 'medium',
    title: 'Invoice Updated',
    message: (d) =>
      d.customMessage
      || `An invoice for unit "${d.unitName || 'Unit'}" has been updated.`,
  },
  INVOICE_DELETED: {
    type: 'invoice_deleted',
    priority: 'high',
    title: 'Invoice Deleted',
    message: (d) =>
      d.customMessage
      || `An invoice for unit "${d.unitName || 'Unit'}" has been deleted.`,
  },
  INVOICE_WAIVED: {
    type: 'invoice_waived',
    priority: 'medium',
    title: 'Invoice Amount Waived',
    message: (d) =>
      d.customMessage
      || `$${d.amount} has been waived on the invoice for unit "${d.unitName || 'Unit'}".`,
  },
  PAYMENT_REMINDER: {
    type: 'payment_reminder',
    priority: 'high',
    title: 'Payment Reminder',
    message: (d) => {
      const invoiceNum = d.invoiceNumber && !/^[0-9a-f]{24}$/i.test(String(d.invoiceNumber))
        ? d.invoiceNumber
        : (d.invoiceRef || 'Invoice');
      const duePart = d.dueDate ? ` due ${d.dueDate}` : '';
      const unitPart = d.unit || d.unitName ? ` · Unit ${d.unit || d.unitName}` : '';
      const amountPart = d.balanceDueFormatted || (d.amount != null ? `$${Number(d.amount).toFixed(2)}` : '');
      return `Reminder: ${invoiceNum} for ${d.propertyName || 'your property'}${unitPart}${amountPart ? ` - ${amountPart} outstanding` : ''}${duePart}.`;
    },
  },
  NOTE_REMINDER: {
    type: 'note_reminder',
    priority: 'high',
    title: 'Note Reminder',
    message: (d) => {
      const base = `Reminder: ${d.noteTitle}${d.entityName ? ` (${d.entityName})` : ''}${d.reminderAt ? ` - due ${d.reminderAt}` : ''}`;
      const body = d.noteBody ? String(d.noteBody).slice(0, 120).trim() : '';
      return body ? `${base}. ${body}` : base;
    },
  },

  // ── Application ───────────────────────────────────────────────────────────────
  APPLICATION_SUBMITTED: {
    type: 'new_application',
    priority: 'medium',
    title: 'New Application Received',
    message: (d) => `${d.applicantName} has submitted a rental application for unit "${d.unitName}".`,
  },
  APPLICATION_APPROVED: {
    type: 'application',
    priority: 'high',
    title: 'Application Approved',
    message: (d) => `Your rental application for unit "${d.unitName}" at "${d.propertyName}" has been approved.`,
  },
  APPLICATION_REJECTED: {
    type: 'application',
    priority: 'high',
    title: 'Application Rejected',
    message: (d) => `Your rental application for unit "${d.unitName}" at "${d.propertyName}" has been rejected.`,
  },

  // ── Tenant ────────────────────────────────────────────────────────────────────
  TENANT_ADDED: {
    type: 'tenant',
    priority: 'low',
    title: 'Tenant Added',
    message: (d) => `${d.tenantName} has been added to unit "${d.unitName}" at "${d.propertyName}".`,
  },
  TENANT_REMOVED: {
    type: 'tenant',
    priority: 'medium',
    title: 'Tenant Removed',
    message: (d) => `${d.tenantName} has been removed from unit "${d.unitName}" at "${d.propertyName}".`,
  },

  // ── Vendor (HOA) ──────────────────────────────────────────────────────────────
  VENDOR_CREATED: {
    type: 'vendor_created',
    priority: 'medium',
    title: 'Vendor Added',
    message: (d) => `Vendor "${d.vendorName}" has been added to the community.`,
  },
  VENDOR_UPDATED: {
    type: 'vendor_updated',
    priority: 'low',
    title: 'Vendor Updated',
    message: (d) => `Vendor "${d.vendorName}" profile has been updated.`,
  },
  VENDOR_DELETED: {
    type: 'vendor_deleted',
    priority: 'high',
    title: 'Vendor Removed',
    message: (d) => `Vendor "${d.vendorName}" has been removed from the community.`,
  },
  VENDOR_ASSIGNED: {
    type: 'vendor_assigned',
    priority: 'medium',
    title: 'Vendor Assigned',
    message: (d) =>
      d.customMessage
      || `Vendor "${d.vendorName}" has been assigned to maintenance ticket "${d.title}" for unit "${d.unitName || 'Unit'}".`,
  },
  VENDOR_INVOICE_CREATED: {
    type: 'vendor_invoice_created',
    priority: 'medium',
    title: 'Vendor Invoice Added',
    message: (d) =>
      d.customMessage
      || `Vendor invoice "${d.invoiceTitle || d.invoiceNumber || 'Invoice'}"${d.amount ? ` of $${d.amount}` : ''} has been added.`,
  },
  VENDOR_INVOICE_UPDATED: {
    type: 'vendor_invoice_updated',
    priority: 'low',
    title: 'Vendor Invoice Updated',
    message: (d) =>
      d.customMessage
      || `Vendor invoice "${d.invoiceTitle || d.invoiceNumber || 'Invoice'}" has been updated.`,
  },
  VENDOR_INVOICE_DELETED: {
    type: 'vendor_invoice_deleted',
    priority: 'high',
    title: 'Vendor Invoice Removed',
    message: (d) =>
      d.customMessage
      || `Vendor invoice "${d.invoiceTitle || d.invoiceNumber || 'Invoice'}" has been removed.`,
  },
  VENDOR_INVOICE_COMMENT_ADDED: {
    type: 'vendor_invoice_comment_added',
    priority: 'low',
    title: 'Vendor Invoice Comment Added',
    message: (d) =>
      d.customMessage
      || `A comment was added to vendor invoice "${d.invoiceTitle || d.invoiceNumber || 'Invoice'}".`,
  },

  // ── Ownership transfer ────────────────────────────────────────────────────────
  OWNERSHIP_CHANGE_SCHEDULED: {
    type: 'ownership_change_scheduled',
    priority: 'medium',
    title: 'Ownership Change Scheduled',
    message: (d) =>
      `An ownership change has been scheduled for ${d.unitLabel || d.propertyName}. `
      + `Current owner: ${d.currentOwnerNames}. New owner: ${d.futureOwnerNames}. `
      + `Effective ${d.effectiveDateLabel}. The change has not taken effect yet.`,
  },
  OWNERSHIP_CHANGE_EFFECTIVE: {
    type: 'ownership_change_effective',
    priority: 'high',
    title: 'Ownership Change Effective',
    message: (d) =>
      `The ownership change for ${d.unitLabel || d.propertyName} is now effective. `
      + `Previous owner: ${d.previousOwnerNames}. New owner: ${d.newOwnerNames}. `
      + `Effective ${d.effectiveDateLabel}.`,
  },

  // ── HOA Fee / Board membership ────────────────────────────────────────────────
  HOA_FEE_UPDATED: {
    type: 'hoa_fee_updated',
    priority: 'medium',
    title: 'HOA Fee Updated',
    message: (d) =>
      d.customMessage
      || `HOA fee settings have been updated${d.hoaName ? ` for ${d.hoaName}` : ''}.`,
  },
  BOARD_MEMBER_UPDATED: {
    type: 'board_member_updated',
    priority: 'medium',
    title: 'Board Member Updated',
    message: (d) =>
      d.customMessage
      || `Board member "${d.memberName}" has been updated.`,
  },
  BOARD_MEMBER_DELETED: {
    type: 'board_member_deleted',
    priority: 'high',
    title: 'Board Member Removed',
    message: (d) =>
      d.customMessage
      || `Board member "${d.memberName}" has been removed from the community.`,
  },
  BOARD_MEMBER_INVITED: {
    type: 'board_member_invited',
    priority: 'medium',
    title: 'Board Member Invited',
    message: (d) =>
      d.customMessage
      || (d.isResend
        ? `Board member invitation resent to ${d.memberName}${d.hoaName ? ` for ${d.hoaName}` : ''}.`
        : `${d.memberName} has been invited to join the board${d.hoaName ? ` for ${d.hoaName}` : ''}.`),
  },
  BOARD_MEMBER_INVITE_ACCEPTED: {
    type: 'board_member_invite_accepted',
    priority: 'medium',
    title: 'Board Invitation Accepted',
    message: (d) =>
      d.customMessage
      || `${d.memberName} has accepted the board member invitation${d.hoaName ? ` for ${d.hoaName}` : ''}.`,
  },
};

module.exports = EVENTS;
