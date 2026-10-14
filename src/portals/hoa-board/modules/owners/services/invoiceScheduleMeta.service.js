/**
 * ------------------------------------------------------------------
 * File: invoiceScheduleMeta.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * owner.service, hoaInvoiceExtensionScheduler.service, unit.service, property.service
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const logger = require('../../../../../common/logger');
const { INVOICE_STATUS, INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  getDateKeyInTimeZone,
  billingCalendarDateKey,
  compareCalendarDateToToday,
  shiftAppYmdDays,
  parseDateOnlyToNoonUtc,
  formatMonthYearInAppTimezone,
} = require('../../../../../common/helpers/hoaBillingDates');
const {
  addUtcCalendarMonths,
  firstMonthlyDueDateUtc,
  parseDateOnlyToUtcParts,
} = require('./unitInvoice.service');
const { allocateUniqueInvoiceId } = require('../../invoice/helpers/invoiceId.helper');
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const { resolvePaymentDueDayFromSources } = require('../helpers/paymentDueDay.helper');
const {
  notifyScheduleInvoicesGenerated,
  notifyNextYearInvoicesCreatedBatch,
} = require('./invoiceScheduleNotify.service');
const { resolvePropertyBillingTimezone } = require('../../../../../common/helpers/billingCalendar');
const { buildTimezonePropertyFilter } = require('../../../../../common/helpers/billingTimezone.constants');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

const EXTENSION_THRESHOLD_DAYS = Number(process.env.HOA_INVOICE_EXTENSION_THRESHOLD_DAYS) || 90;
const DEFAULT_EXTENSION_MONTHS = Number(process.env.HOA_INVOICE_EXTENSION_MONTHS) || 12;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * snap Payment Term Months To Schema
 *
 * Performs logic operations for snapPaymentTermMonthsToSchema.
 *
 * @param months - Request/input argument
 * @returns Operations result
 */
function snapPaymentTermMonthsToSchema(months) {
  const m = Number(months);
  if (!Number.isFinite(m) || m <= 0) return 12;
  const allowed = [12, 24, 36, 60];
  if (allowed.includes(m)) return m;
  const higher = allowed.find((a) => a >= m);
  return higher || 60;
}

/**
 * balance As Of To Ymd
 *
 * Performs logic operations for balanceAsOfToYmd.
 *
 * @param balanceAsOf - Request/input argument
 * @returns Operations result
 */
function balanceAsOfToYmd(balanceAsOf) {
  if (!balanceAsOf) return null;
  return billingCalendarDateKey(balanceAsOf);
}

/**
 * calendar Days Between
 *
 * Performs logic operations for calendarDaysBetween.
 *
 * @param fromYmd - Request/input argument
 * @param toYmd - Request/input argument
 * @returns Operations result
 */
function calendarDaysBetween(fromYmd, toYmd) {
  const fromMs = parseDateOnlyToNoonUtc(fromYmd)?.getTime();
  const toMs = parseDateOnlyToNoonUtc(toYmd)?.getTime();
  if (fromMs == null || toMs == null) return 0;
  return Math.floor((toMs - fromMs) / DAY_MS);
}

/**
 * parse Month Number
 *
 * Performs logic operations for parseMonthNumber.
 *
 * @param term - Request/input argument
 * @returns Operations result
 */
function parseMonthNumber(term) {
  const m = /^Month\s+(\d+)$/i.exec(String(term || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * format Term From Date
 *
 * Performs logic operations for formatTermFromDate.
 *
 * @param date - Request/input argument
 * @returns Operations result
 */
function formatTermFromDate(date) {
  return formatMonthYearInAppTimezone(date, { longMonth: true });
}

function resolveUnitBillingTimezone(unit) {
  return resolvePropertyBillingTimezone(unit);
}

/**
 * compute Schedule Month Number
 *
 * Performs logic operations for computeScheduleMonthNumber.
 *
 * @param dueDate - Request/input argument
 * @param firstDue - Request/input argument
 * @returns Operations result
 */
function computeScheduleMonthNumber(dueDate, firstDue) {
  if (!dueDate || !firstDue) return null;
  const dueKey = billingCalendarDateKey(dueDate);
  const firstKey = billingCalendarDateKey(firstDue);
  if (!dueKey || !firstKey) return null;
  const dueParts = dueKey.split('-').map(Number);
  const firstParts = firstKey.split('-').map(Number);
  const yearDiff = dueParts[0] - firstParts[0];
  const monthDiff = dueParts[1] - firstParts[1];
  const monthNum = yearDiff * 12 + monthDiff + 1;
  return Number.isFinite(monthNum) && monthNum > 0 ? monthNum : null;
}

async function loadScheduleState(unitId) {
  const safeUnitId = toObjectId(unitId);
  if (!safeUnitId) return { maxMonth: 0, lastDue: null, monthSet: new Set(), rowCount: 0 };
  const rows = await Invoice.find({
    propertyId: safeUnitId,
    generatedFrom: 'unit_schedule',
    isDeleted: { $ne: true },
  })
    .select('term dueDate')
    .sort({ dueDate: 1 })
    .lean();

  let maxMonth = 0;
  let lastDue = null;
  const monthSet = new Set();
  const firstDue = rows.find((row) => row.dueDate)?.dueDate || null;

  for (const row of rows) {
    const dueDate = row.dueDate ? DateUtil.toUTC(row.dueDate) : null;
    if (!dueDate) continue;
    let monthNum = computeScheduleMonthNumber(dueDate, firstDue);
    if (!monthNum) monthNum = parseMonthNumber(row.term);
    if (monthNum) {
      maxMonth = Math.max(maxMonth, monthNum);
      monthSet.add(monthNum);
    }
    const dueMs = dueDate.getTime();
    const lastMs = lastDue ? DateUtil.toEpoch(lastDue) : null;
    if (!lastDue || (lastMs != null && dueMs > lastMs)) {
      lastDue = dueDate;
    }
  }

  return { maxMonth, lastDue, monthSet, rowCount: rows.length };
}

/**
 * Countdown until the cron extends the unit billing schedule (90 days before last invoice).
 */
async function getInvoiceScheduleMetaForUnit(unitId, options = {}) {
  const safeUnitId = toObjectId(unitId);
  if (!safeUnitId) return null;
  const unit = options.unit || await Property.findOne({
    _id: safeUnitId,
    isDeleted: { $ne: true },
  })
    .select('monthlyRecurringFee paymentTerm balanceAsOf hasGeneratedInvoices billingTimezone')
    .lean();

  if (!unit || !(Number(unit.monthlyRecurringFee) > 0)) {
    return null;
  }

  const { maxMonth, lastDue } = await loadScheduleState(unitId);
  if (!lastDue || maxMonth <= 0) {
    return {
      daysUntilNextInvoiceGeneration: null,
      nextGenerationDate: null,
      lastScheduleInvoiceDueDate: null,
      scheduleMonthCount: 0,
      paymentTermMonths: snapPaymentTermMonthsToSchema(unit.paymentTerm),
    };
  }

  const timezone = resolveUnitBillingTimezone(unit);
  const todayKey = getDateKeyInTimeZone(ClockService.now(), timezone);
  const lastDueKey = billingCalendarDateKey(lastDue, timezone);
  const nextGenerationDate = lastDueKey ? shiftAppYmdDays(lastDueKey, -EXTENSION_THRESHOLD_DAYS) : null;
  const daysUntilNextInvoiceGeneration = nextGenerationDate && todayKey
    ? Math.max(0, calendarDaysBetween(todayKey, nextGenerationDate))
    : null;

  return {
    daysUntilNextInvoiceGeneration,
    nextGenerationDate,
    lastScheduleInvoiceDueDate: lastDueKey,
    scheduleMonthCount: maxMonth,
    paymentTermMonths: snapPaymentTermMonthsToSchema(unit.paymentTerm),
    extensionThresholdDays: EXTENSION_THRESHOLD_DAYS,
  };
}

async function getInvoiceScheduleMetaForOwnerUnits(propertyIds = []) {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
    return { daysUntilNextInvoiceGeneration: null, units: [] };
  }

  const units = [];
  for (const propertyId of propertyIds) {
    // eslint-disable-next-line no-await-in-loop
    const meta = await getInvoiceScheduleMetaForUnit(propertyId);
    if (meta && meta.daysUntilNextInvoiceGeneration != null) {
      units.push({ propertyId: String(propertyId), ...meta });
    }
  }

  const daysUntilNextInvoiceGeneration = units.length
    ? Math.min(...units.map((u) => u.daysUntilNextInvoiceGeneration))
    : null;

  return { daysUntilNextInvoiceGeneration, units };
}

async function resolveDueDayForUnit(unit) {
  const prevRp = unit.requestPayload && typeof unit.requestPayload === 'object' && !Array.isArray(unit.requestPayload)
    ? unit.requestPayload
    : {};
  let hoaSettings = null;
  if (unit.hoaId) {
    hoaSettings = await HOASettings.findOne({ hoaId: unit.hoaId }).select('paymentTerm').lean();
  }
  return resolvePaymentDueDayFromSources({
    requestPayload: prevRp,
    hoaSettings,
  });
}

async function extendUnitScheduleIfNeeded(unit, options = {}) {
  const fee = Number(unit.monthlyRecurringFee);
  if (!unit?._id || !Number.isFinite(fee) || fee <= 0) {
    return { extended: false, createdInvoices: 0 };
  }

  const { maxMonth, lastDue, monthSet } = await loadScheduleState(unit._id);
  if (!lastDue || maxMonth <= 0) {
    return { extended: false, createdInvoices: 0, reason: 'no_schedule' };
  }

  const timezone = resolveUnitBillingTimezone(unit);
  const daysUntilLast = calendarDaysBetween(
    getDateKeyInTimeZone(ClockService.now(), timezone),
    billingCalendarDateKey(lastDue, timezone),
  );

  if (daysUntilLast > EXTENSION_THRESHOLD_DAYS) {
    return { extended: false, createdInvoices: 0, reason: 'outside_window', daysUntilLast };
  }

  const extensionMonths = snapPaymentTermMonthsToSchema(
    options.extensionMonths || unit.paymentTerm || DEFAULT_EXTENSION_MONTHS,
  );
  const startMonth = maxMonth + 1;
  const endMonth = maxMonth + extensionMonths;

  if (monthSet.has(startMonth)) {
    return { extended: false, createdInvoices: 0, reason: 'already_extended' };
  }

  const ymd = balanceAsOfToYmd(unit.balanceAsOf);
  const parts = ymd ? parseDateOnlyToUtcParts(ymd) : null;
  if (!parts) {
    return { extended: false, createdInvoices: 0, reason: 'missing_balance_as_of' };
  }

  const dueDay = await resolveDueDayForUnit(unit);
  const firstDue = firstMonthlyDueDateUtc(parts, dueDay);
  const ownerIds = (unit.associatedOwnerIds || [])
    .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  if (ownerIds.length === 0) {
    return { extended: false, createdInvoices: 0, reason: 'no_owners' };
  }

  const unitLabel =
    (unit.unitDetails && unit.unitDetails[0] && unit.unitDetails[0].unitName)
    || unit.name
    || 'Unit';
  const propertyName = unit.name || 'Property';
  const effFee = Number(fee.toFixed(2));
  let createdInvoices = 0;
  const createdInvoiceDocs = [];

  for (let monthNum = startMonth; monthNum <= endMonth; monthNum += 1) {
    if (monthSet.has(monthNum)) continue;

    const dueDate = addUtcCalendarMonths(firstDue, monthNum - 1);
    const cmpDue = compareCalendarDateToToday(dueDate, ClockService.now(), timezone);
    const initialStatus = cmpDue < 0 ? INVOICE_STATUS.OVERDUE : INVOICE_STATUS.PENDING;

    const invoiceIdAssigned = await allocateUniqueInvoiceId();
    const scheduled = new Invoice({
      invoiceId: invoiceIdAssigned,
      type: INVOICE_TYPES.FEES,
      status: initialStatus,
      propertyId: unit._id,
      hoaId: unit.hoaId || undefined,
      propertyName,
      unit: unitLabel,
      term: formatTermFromDate(dueDate),
      tenants: ownerIds,
      invoiceItemDetails: [{
        invoiceItem: 'Monthly Fee',
        description: `Monthly recurring fee (${formatTermFromDate(dueDate)}).`,
        quantity: 1,
        rate: effFee,
        amount: effFee,
      }],
      subAmount: effFee,
      alreadyPaid: 0,
      balanceDue: effFee,
      isPartialPaymentAllowed: true,
      dueDate,
      notes: '',
      generatedFrom: 'unit_schedule',
      ...(unit.createdBy || unit.hoaBoardMemberId || unit.landlord_id
        ? { createdBy: unit.createdBy || unit.hoaBoardMemberId || unit.landlord_id }
        : {}),
    });

    // eslint-disable-next-line no-await-in-loop
    await scheduled.save();
    createdInvoices += 1;
    createdInvoiceDocs.push(scheduled);
  }

  if (createdInvoices > 0 && options.notify !== false && !options.deferNotifications) {
    await notifyScheduleInvoicesGenerated({
      unit,
      invoiceCount: createdInvoices,
      context: 'schedule_extension',
      invoices: createdInvoiceDocs,
    });
  }

  return {
    extended: createdInvoices > 0,
    createdInvoices,
    createdInvoiceDocs,
    startMonth,
    endMonth,
  };
}

async function processAllUnitsInvoiceExtension(options = {}) {
  const timezoneFilter = options.billingTimezone
    ? buildTimezonePropertyFilter(options.billingTimezone)
    : {};
  const units = await Property.find({
    ...timezoneFilter,
    hoaId: { $exists: true, $ne: null },
    isDeleted: { $ne: true },
    monthlyRecurringFee: { $gt: 0 },
    hasGeneratedInvoices: true,
  })
    .select('_id name unitDetails hoaId monthlyRecurringFee paymentTerm balanceAsOf associatedOwnerIds requestPayload createdBy hoaBoardMemberId landlord_id billingTimezone')
    .lean();

  let processed = 0;
  let extended = 0;
  let created = 0;
  let failed = 0;
  const allCreatedInvoiceDocs = [];

  for (const unit of units) {
    processed += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await extendUnitScheduleIfNeeded(unit, {
        ...options,
        deferNotifications: true,
      });
      if (result.extended) {
        extended += 1;
        created += result.createdInvoices || 0;
        if (Array.isArray(result.createdInvoiceDocs) && result.createdInvoiceDocs.length > 0) {
          allCreatedInvoiceDocs.push(...result.createdInvoiceDocs);
        }
      }
    } catch (error) {
      failed += 1;
      logger.warn(
        '[invoiceScheduleExtension] Unit extension failed:',
        String(unit._id),
        error?.message || error,
      );
    }
  }

  if (allCreatedInvoiceDocs.length > 0 && options.notify !== false) {
    await notifyNextYearInvoicesCreatedBatch(allCreatedInvoiceDocs);
  }

  return { processed, extended, created, failed };
}

module.exports = {
  EXTENSION_THRESHOLD_DAYS,
  DEFAULT_EXTENSION_MONTHS,
  getInvoiceScheduleMetaForUnit,
  getInvoiceScheduleMetaForOwnerUnits,
  extendUnitScheduleIfNeeded,
  processAllUnitsInvoiceExtension,
  resolveUnitBillingTimezone,
};
