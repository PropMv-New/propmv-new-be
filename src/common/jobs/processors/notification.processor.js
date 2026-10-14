'use strict';

const { JOB_TYPES } = require('../constants');
const { recordNotificationLog } = require('../notificationLog.service');
const logger = require('../../logger');

async function processNotificationJob(job) {
  const payload = job.payload || {};
  const hoaInApp = require('../../helpers/hoaInAppNotify.helper');
  const hoaEntity = require('../../helpers/hoaEntityNotify.helper');
  const { notify } = require('../../notifications');

  const handler = payload.handler || job.jobType;
  let result;

  switch (handler) {
    case 'invoice_created': {
      const Invoice = require('../../../portals/hoa-board/modules/invoice/model/invoice.model');
      const invoice = await Invoice.findById(payload.invoiceId);
      if (!invoice) {
        const err = new Error('Invoice not found for in-app notify');
        err.permanent = true;
        throw err;
      }
      result = await hoaInApp.notifyInvoiceCreatedInApp(invoice, payload.actorUserId || null);
      break;
    }
    case 'invoice_updated': {
      const Invoice = require('../../../portals/hoa-board/modules/invoice/model/invoice.model');
      const invoice = await Invoice.findById(payload.invoiceId);
      if (!invoice) {
        const err = new Error('Invoice not found for in-app notify');
        err.permanent = true;
        throw err;
      }
      result = await hoaInApp.notifyInvoiceUpdatedInApp(invoice, payload.actorUserId || null);
      break;
    }
    case 'invoice_deleted': {
      result = await hoaInApp.notifyInvoiceDeletedInApp(payload.invoice || payload, payload.actorUserId || null);
      break;
    }
    case 'invoice_waived': {
      const Invoice = require('../../../portals/hoa-board/modules/invoice/model/invoice.model');
      const invoice = payload.invoiceId
        ? await Invoice.findById(payload.invoiceId)
        : (payload.invoice || payload);
      if (!invoice) {
        const err = new Error('Invoice not found for waive notify');
        err.permanent = true;
        throw err;
      }
      result = await hoaInApp.notifyInvoiceWaivedInApp(
        invoice,
        payload.actorUserId || null,
        payload.waivedAmount || 0
      );
      break;
    }
    case 'payment_received': {
      const Invoice = require('../../../portals/hoa-board/modules/invoice/model/invoice.model');
      const invoice = payload.invoiceId ? await Invoice.findById(payload.invoiceId) : payload.invoice;
      if (!invoice) {
        const err = new Error('Invoice not found for payment notify');
        err.permanent = true;
        throw err;
      }
      result = await runPaymentReceived(invoice, payload);
      break;
    }
    case 'payment_deleted':
      result = await runPaymentDeleted(payload);
      break;
    case 'payment_failed':
      result = await runPaymentFailed(payload);
      break;
    case 'payment_processing':
      result = await runPaymentProcessing(payload);
      break;
    case 'maintenance_created':
      result = await hoaInApp.notifyMaintenanceCreatedInApp(payload.doc || payload.maintenanceRequest, payload.actorUserId, payload.options || {});
      break;
    case 'maintenance_updated':
      result = await hoaInApp.notifyMaintenanceUpdatedInApp(payload.doc, payload.actorUserId, payload.options || {});
      break;
    case 'maintenance_vendor_assigned':
      result = await hoaInApp.notifyMaintenanceVendorAssignedInApp(payload.doc, payload.actorUserId);
      break;
    case 'maintenance_comment':
      result = await hoaInApp.notifyMaintenanceCommentInApp(payload.doc, payload.actorUserId);
      break;
    case 'maintenance_note':
      result = await hoaInApp.notifyMaintenanceNoteInApp(payload.doc, payload.actorUserId);
      break;
    case 'maintenance_documents':
      result = await hoaInApp.notifyMaintenanceDocumentsInApp(payload.doc, payload.actorUserId);
      break;
    case 'expense_created':
      result = await hoaInApp.notifyExpenseCreatedInApp(payload.expense, payload.actorUserId);
      break;
    case 'expense_updated':
      result = await hoaInApp.notifyExpenseUpdatedInApp(payload.expense, payload.actorUserId);
      break;
    case 'expense_paid':
      result = await hoaInApp.notifyExpensePaidInApp(payload.expense, payload.actorUserId);
      break;
    case 'expense_deleted':
      result = await hoaInApp.notifyExpenseDeletedInApp(payload.expense, payload.actorUserId);
      break;
    case 'document_uploaded':
      result = await hoaInApp.notifyDocumentUploadedInApp(payload.document, payload.actorUserId, payload.options || {});
      break;
    case 'property_created':
      result = await hoaEntity.notifyPropertyCreatedInApp(payload.property, payload.actorUserId);
      break;
    case 'property_updated':
      result = await hoaEntity.notifyPropertyUpdatedInApp(payload.property, payload.actorUserId);
      break;
    case 'property_deleted':
      result = await hoaEntity.notifyPropertyDeletedInApp(payload, payload.actorUserId);
      break;
    case 'owner_created':
      result = await hoaEntity.notifyOwnerCreatedInApp(payload.owner, payload.actorUserId, payload.hoaId);
      break;
    case 'owner_updated':
      result = await hoaEntity.notifyOwnerUpdatedInApp(payload.owner, payload.actorUserId, payload.hoaId);
      break;
    case 'owner_archived':
      result = await hoaEntity.notifyOwnerArchivedInApp(payload, payload.actorUserId);
      break;
    case 'owner_deleted':
      result = await hoaEntity.notifyOwnerDeletedInApp(payload, payload.actorUserId);
      break;
    case 'vendor_created':
      result = await hoaInApp.notifyVendorCreatedInApp(payload.vendor, payload.actorUserId, payload.hoaId);
      break;
    case 'vendor_updated':
      result = await hoaInApp.notifyVendorUpdatedInApp(payload.vendor, payload.actorUserId, payload.hoaId);
      break;
    case 'vendor_deleted':
      result = await hoaInApp.notifyVendorDeletedInApp(payload.vendor, payload.actorUserId, payload.hoaId);
      break;
    case 'vendor_assigned':
      result = await hoaInApp.notifyVendorAssignedInApp(payload);
      break;
    case 'schedule_invoices_generated_unit': {
      const { notifyScheduleInvoicesGenerated } = require('../../../portals/hoa-board/modules/owners/services/invoiceScheduleNotify.service');
      await notifyScheduleInvoicesGenerated({
        unit: payload.unit,
        invoiceCount: payload.invoiceCount,
        context: payload.context,
        invoices: payload.invoices || [],
      });
      result = { sent: 1 };
      break;
    }
    case 'landlord_payment_received': {
      const { notify, EVENTS } = require('../../notifications');
      if (!payload.tenantUserId) return { sent: 0 };
      const amount = Number(payload.amount || 0);
      await notify(
        EVENTS.PAYMENT_RECEIVED,
        {
          amount: amount.toFixed(2),
          unitName: payload.unitName || 'Unit',
        },
        String(payload.tenantUserId),
        {
          invoiceId: payload.invoiceId,
          invoiceNumber: payload.invoiceNumber || null,
          paymentAmount: amount,
        }
      );
      result = { sent: 1 };
      break;
    }
    case 'generic':
    case JOB_TYPES.NOTIFY_GENERIC: {
      const { notify } = require('../../notifications');
      result = await notify(
        payload.event,
        payload.data || {},
        payload.recipients,
        payload.metadata || {},
        payload.options || {}
      );
      break;
    }
    default: {
      if (payload.event && payload.recipients) {
        result = await notify(
          payload.event,
          payload.data || {},
          payload.recipients,
          payload.metadata || {},
          payload.options || {}
        );
        break;
      }
      const err = new Error(`Unsupported notification handler: ${handler}`);
      err.permanent = true;
      throw err;
    }
  }

  await recordNotificationLog({
    jobId: job.jobId,
    type: handler,
    channel: 'in-app',
    recipientType: job.recipientType,
    recipientId: job.recipientId,
    entityType: job.entityType,
    entityId: job.entityId,
    activityId: job.eventId,
    subject: payload.subject || payload.event?.title || handler,
    status: 'sent',
    attempts: job.attempts || 0,
    workerId: job.workerId,
    metadata: result || null,
  }).catch((logErr) => {
    logger.warn('[NotificationProcessor] log failed', { error: logErr.message, jobId: job.jobId });
  });

  return result || { ok: true };
}

async function runPaymentReceived(invoice, payload) {
  const { notify, EVENTS } = require('../../notifications');
  const { resolveInvoicePaymentRecipients, toIdString } = require('../../helpers/hoaRecipientResolver');
  const recipients = await resolveInvoicePaymentRecipients(invoice, payload.actorUserId || null);
  if (!recipients.length) return { sent: 0 };
  const paymentAmount = Number(payload.amount || 0);
  await notify(
    EVENTS.PAYMENT_RECEIVED,
    {
      amount: paymentAmount.toFixed(2),
      unitName: invoice.unit || invoice.unitName || 'Unit',
    },
    recipients,
    {
      hoaId: invoice.hoaId ? String(invoice.hoaId) : undefined,
      entityType: 'invoice',
      entityId: toIdString(invoice._id),
      invoiceId: toIdString(invoice._id),
    },
    { idempotencyKey: payload.idempotencyKey || `payment_received:${toIdString(invoice._id)}:${paymentAmount}` }
  );
  return { sent: recipients.length };
}

async function runPaymentDeleted(payload) {
  const Invoice = require('../../../portals/hoa-board/modules/invoice/model/invoice.model');
  const { notify, EVENTS } = require('../../notifications');
  const { resolveInvoicePaymentRecipients, toIdString } = require('../../helpers/hoaRecipientResolver');
  const invoice = payload.invoiceId ? await Invoice.findById(payload.invoiceId) : payload.invoice;
  if (!invoice) {
    const err = new Error('Invoice not found for payment deleted notify');
    err.permanent = true;
    throw err;
  }
  const recipients = await resolveInvoicePaymentRecipients(invoice, payload.actorUserId || null);
  if (!recipients.length) return { sent: 0 };
  const paymentAmount = Number(payload.amount || 0);
  await notify(
    EVENTS.PAYMENT_DELETED,
    {
      amount: paymentAmount.toFixed(2),
      unitName: invoice.unit || invoice.unitName || 'Unit',
    },
    recipients,
    {
      hoaId: invoice.hoaId ? String(invoice.hoaId) : undefined,
      entityType: 'invoice',
      entityId: toIdString(invoice._id),
      invoiceId: toIdString(invoice._id),
    },
    { idempotencyKey: payload.idempotencyKey || `payment_deleted:${toIdString(invoice._id)}:${paymentAmount}` }
  );
  return { sent: recipients.length };
}

async function runPaymentStatusNotify(payload, eventKey, typeKey) {
  const Invoice = require('../../../portals/hoa-board/modules/invoice/model/invoice.model');
  const { notify, EVENTS } = require('../../notifications');
  const { resolveInvoicePaymentRecipients, toIdString } = require('../../helpers/hoaRecipientResolver');
  const invoice = payload.invoiceId ? await Invoice.findById(payload.invoiceId) : payload.invoice;
  if (!invoice) {
    const err = new Error(`Invoice not found for ${typeKey} notify`);
    err.permanent = true;
    throw err;
  }
  const recipients = await resolveInvoicePaymentRecipients(invoice, payload.actorUserId || null);
  if (!recipients.length) return { sent: 0 };
  const paymentAmount = Number(payload.amount || 0);
  const unitName = invoice.unit || invoice.unitName || 'Unit';
  const event = EVENTS[eventKey];
  await notify(
    event,
    {
      amount: paymentAmount.toFixed(2),
      unitName,
      customMessage: payload.customMessage,
    },
    recipients,
    {
      hoaId: invoice.hoaId ? String(invoice.hoaId) : undefined,
      entityType: 'invoice',
      entityId: toIdString(invoice._id),
      invoiceId: toIdString(invoice._id),
    },
    { idempotencyKey: payload.idempotencyKey || `${typeKey}:${toIdString(invoice._id)}:${paymentAmount}` }
  );
  return { sent: recipients.length };
}

async function runPaymentFailed(payload) {
  return runPaymentStatusNotify(payload, 'PAYMENT_FAILED', 'payment_failed');
}

async function runPaymentProcessing(payload) {
  return runPaymentStatusNotify(payload, 'PAYMENT_PROCESSING', 'payment_processing');
}

module.exports = {
  processNotificationJob,
};
