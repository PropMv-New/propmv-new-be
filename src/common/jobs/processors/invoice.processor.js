'use strict';

const { JOB_TYPES } = require('../constants');
const { getDateKeyInTimeZone, APP_TIMEZONE } = require('../../helpers/hoaBillingDates');
const { ClockService } = require('../../date');

async function processInvoiceJob(job) {
  const payload = job.payload || {};
  const type = job.jobType;

  switch (type) {
    case JOB_TYPES.INVOICE_LATE_FEE_UNIT: {
      const { ensureLateFeeInvoicesForUnit } = require('../../../portals/hoa-board/modules/owners/services/unitLateFee.service');
      const rows = await ensureLateFeeInvoicesForUnit(payload.unitId, {
        billingTimezone: payload.billingTimezone,
        scheduledRun: payload.scheduledRun !== false,
        onlyInvoiceId: payload.onlyInvoiceId || undefined,
        forceApply: payload.forceApply === true,
      });
      return { created: Array.isArray(rows) ? rows.length : 0 };
    }
    case JOB_TYPES.INVOICE_LATE_FEE_LANDLORD: {
      const { generateLateFeeForInvoice } = require('../../../portals/landlord/modules/invoice/service/lateFeeInvoice.service');
      return generateLateFeeForInvoice(payload.invoiceId);
    }
    case JOB_TYPES.INVOICE_EXTENSION_ALL: {
      const { processAllUnitsInvoiceExtension } = require('../../../portals/hoa-board/modules/owners/services/invoiceScheduleMeta.service');
      return processAllUnitsInvoiceExtension({
        ...(payload.options || {}),
        billingTimezone: payload.billingTimezone || payload.options?.billingTimezone,
      });
    }
    case JOB_TYPES.INVOICE_EXTENSION_UNIT: {
      const Property = require('../../../portals/hoa-board/modules/property/model/property.model');
      const { extendUnitScheduleIfNeeded } = require('../../../portals/hoa-board/modules/owners/services/invoiceScheduleMeta.service');
      const unit = await Property.findOne({ _id: payload.unitId, isDeleted: { $ne: true } }).lean();
      if (!unit) {
        const err = new Error('Unit not found for invoice extension');
        err.permanent = true;
        throw err;
      }
      return extendUnitScheduleIfNeeded(unit, payload.options || {});
    }
    case JOB_TYPES.INVOICE_PAYMENT_REMINDER: {
      const Invoice = require('../../../portals/hoa-board/modules/invoice/model/invoice.model');
      const HOASettings = require('../../../portals/hoa-board/modules/hoa-settings/model/hoaSettings.model');
      const { processInvoiceAutomatedReminders } = require('../../helpers/paymentReminderAutomation.service');
      const { normalizePaymentReminderConfig } = require('../../helpers/paymentReminderConfig.helper');
      const invoice = await Invoice.findById(payload.invoiceId).lean();
      if (!invoice) {
        const err = new Error('Invoice not found for payment reminder');
        err.permanent = true;
        throw err;
      }
      const hoaSettings = invoice.hoaId
        ? await HOASettings.findOne({ hoaId: invoice.hoaId }).lean()
        : null;
      const config = normalizePaymentReminderConfig(hoaSettings || {});
      if (!config.enabled) return { skipped: true, reason: 'disabled' };
      return processInvoiceAutomatedReminders(
        invoice,
        config,
        payload.referenceDate ? new Date(payload.referenceDate) : ClockService.now(),
        {
          gracePeriodDays: Number(hoaSettings?.paymentTerm?.gracePeriodDays) || 0,
          billingTimezone: payload.billingTimezone,
        },
        { reminderPhase: payload.reminderPhase || 'all' },
      );
    }
    case JOB_TYPES.INVOICE_PAYMENT_REMINDER_RETRY: {
      const { retryFailedAutomatedReminders } = require('../../helpers/paymentReminderAutomation.service');
      return retryFailedAutomatedReminders();
    }
    default: {
      const err = new Error(`Unsupported invoice job type: ${type}`);
      err.permanent = true;
      throw err;
    }
  }
}

function reminderDateKey(referenceDate, timeZone = APP_TIMEZONE) {
  return getDateKeyInTimeZone(referenceDate || ClockService.now(), timeZone);
}

module.exports = {
  processInvoiceJob,
  reminderDateKey,
};
