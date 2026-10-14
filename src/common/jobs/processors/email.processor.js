'use strict';

const { JOB_TYPES } = require('../constants');
const { recordNotificationLog } = require('../notificationLog.service');
const logger = require('../../logger');

function invoiceIdFrom(payload = {}) {
  return payload.invoiceId || payload.invoice?._id || payload.invoice || null;
}

async function processEmailJob(job) {
  const payload = job.payload || {};
  const type = job.jobType;
  const invoiceLifecycle = require('../../helpers/invoiceLifecycleEmail.service');
  const invoiceNotify = require('../../helpers/invoiceNotificationEmailHelper');
  const transactional = require('../../helpers/transactionalEmail.service');
  const maintenanceEmail = require('../../helpers/maintenanceEmailHelper');
  const emailHelper = require('../../helpers/emailHelper');

  let result;

  switch (type) {
    case JOB_TYPES.EMAIL_INVOICE_CREATED:
      result = await invoiceLifecycle.sendInvoiceCreatedEmail(invoiceIdFrom(payload));
      break;
    case JOB_TYPES.EMAIL_INVOICE_UPDATED:
      result = await invoiceLifecycle.sendInvoiceUpdatedEmail({
        invoice: invoiceIdFrom(payload),
        changeDescriptions: payload.changeDescriptions || [],
        activityIntro: payload.activityIntro || '',
        recordedByUserId: payload.recordedByUserId || null,
        occurredAt: payload.occurredAt || null,
      });
      break;
    case JOB_TYPES.EMAIL_PAYMENT_RECORDED:
      result = await invoiceLifecycle.sendPaymentRecordedEmail({
        ...payload,
        invoice: invoiceIdFrom(payload),
      });
      break;
    case JOB_TYPES.EMAIL_PAYMENT_DELETED:
      result = await invoiceLifecycle.sendPaymentDeletedEmail({
        ...payload,
        invoice: invoiceIdFrom(payload),
      });
      break;
    case JOB_TYPES.EMAIL_INVOICE_BALANCE_WAIVED:
      result = await invoiceLifecycle.sendInvoiceBalanceWaivedEmail({
        ...payload,
        invoice: invoiceIdFrom(payload),
      });
      break;
    case JOB_TYPES.EMAIL_PAYMENT_RECEIVED:
      result = await invoiceNotify.sendPaymentReceivedEmail({
        ...payload,
        invoice: invoiceIdFrom(payload),
      });
      break;
    case JOB_TYPES.EMAIL_PAYMENT_FAILED:
      result = await invoiceNotify.sendPaymentFailedEmail({
        ...payload,
        invoice: invoiceIdFrom(payload),
      });
      break;
    case JOB_TYPES.EMAIL_LATE_FEE_APPLIED: {
      const invoice = await invoiceNotify.loadInvoiceForEmail(payload.invoiceId);
      if (!invoice) {
        const err = new Error('Invoice not found for late fee email');
        err.permanent = true;
        throw err;
      }
      result = await invoiceNotify.sendLateFeeNotificationEmail({
        invoice,
        lateFeeAmount: payload.amount || payload.lateFeeAmount,
        lateFeeSequence: payload.lateFeeSequence || 1,
      });
      break;
    }
    case JOB_TYPES.EMAIL_MAINTENANCE_CREATED:
    case JOB_TYPES.MAINTENANCE_CREATED: {
      const MaintenanceRequest = require('../../../shared/modules/maintenance/model/maintenanceRequest.model');
      const savedDoc = payload.maintenanceId
        ? await MaintenanceRequest.findById(payload.maintenanceId).lean()
        : payload.maintenanceRequest;
      if (!savedDoc) {
        const err = new Error('Maintenance request not found');
        err.permanent = true;
        throw err;
      }
      result = await maintenanceEmail.sendMaintenanceRequestCreatedEmail(savedDoc);
      break;
    }
    case JOB_TYPES.EMAIL_MAINTENANCE_NOTIFICATION:
      result = await emailHelper.sendEmail(
        'maintenance-ticket-notification',
        payload.toEmail,
        payload.data || {},
        {
          template: 'maintenance-ticket-notification',
          subject: payload.subject || 'New maintenance ticket',
          preheaderText: payload.preheaderText,
        }
      );
      break;
    case JOB_TYPES.EMAIL_INVOICE_SCHEDULE_SUMMARY:
      if (payload.mode === 'next_year') {
        result = await invoiceLifecycle.sendConsolidatedNextYearInvoiceCreatedEmails(
          payload.invoiceIds || payload.invoiceRefs || []
        );
      } else {
        result = await invoiceLifecycle.sendConsolidatedScheduleInvoiceCreatedEmails(
          payload.invoiceIds || payload.invoiceRefs || []
        );
      }
      break;
    case JOB_TYPES.EMAIL_LANDLORD_INVOICE_UPDATED: {
      const landlordInvoice = require('../../../portals/landlord/modules/invoice/service/invoice.service');
      if (typeof landlordInvoice.sendLandlordInvoiceUpdatedEmails !== 'function') {
        const err = new Error('Landlord invoice email sender is not available');
        err.permanent = true;
        throw err;
      }
      result = await landlordInvoice.sendLandlordInvoiceUpdatedEmails(payload.invoiceId);
      break;
    }
    case JOB_TYPES.EMAIL_TRANSACTIONAL:
      result = await transactional.sendTransactionalEmail(payload);
      break;
    case JOB_TYPES.EMAIL_NOTE_REMINDER_SWEEP: {
      const { processDueNoteReminders } = require('../../services/noteReminder.service');
      result = await processDueNoteReminders();
      break;
    }
    default: {
      const err = new Error(`Unsupported email job type: ${type}`);
      err.permanent = true;
      throw err;
    }
  }

  await recordNotificationLog({
    jobId: job.jobId,
    type: job.jobType,
    channel: 'email',
    recipientType: job.recipientType,
    recipientId: job.recipientId,
    recipientEmail: payload.toEmail || payload.recipientEmail || '',
    entityType: job.entityType,
    entityId: job.entityId,
    activityId: job.eventId,
    subject: payload.subject || payload.options?.subject || '',
    status: result?.sent === false && result?.skipped ? 'skipped' : 'sent',
    attempts: job.attempts || 0,
    workerId: job.workerId,
    metadata: result || null,
  }).catch((logErr) => {
    logger.warn('[EmailProcessor] notification log failed', { error: logErr.message, jobId: job.jobId });
  });

  return result || { ok: true };
}

module.exports = {
  processEmailJob,
};
