/**
 * ------------------------------------------------------------------
 * File: unitScheduleRecalc.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * hoaSettings.service, unit.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Property = require('../../property/model/property.model');
const Invoice = require('../../invoice/model/invoice.model');
const { INVOICE_STATUS, INVOICE_TYPES } = require('../../../../../common/constants/invoice');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  parseDateOnlyToUtcParts,
  firstMonthlyDueDateUtc,
  addUtcCalendarMonths,
} = require('./unitInvoice.service');
const { allocateUniqueInvoiceId } = require('../../invoice/helpers/invoiceId.helper');
const { getDateKeyInTimeZone, billingCalendarDateKey, compareCalendarDateToToday, formatMonthYearInAppTimezone } = require('../../../../../common/helpers/hoaBillingDates');
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const { resolvePaymentDueDayFromSources } = require('../helpers/paymentDueDay.helper');

const formatTermFromDate = (date) => formatMonthYearInAppTimezone(date, { longMonth: true });

const getScheduleMonthNumber = (dueDate, firstDue) => {
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
};

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

/** Mirrors HOA Property.paymentTerm schema: one of 12 | 24 | 36 | 60 */
function snapPaymentTermMonthsToSchema(months) {
  const m = Number(months);
  if (!Number.isFinite(m) || m <= 0) return 12;
  const allowed = [12, 24, 36, 60];
  if (allowed.includes(m)) return m;
  const higher = allowed.find((a) => a >= m);
  return higher || 60;
}

/** YYYY-MM-DD for balance-as-of from a Property.balanceAsOf value */
function balanceAsOfToYmd(balanceAsOf) {
  if (!balanceAsOf) return null;
  return billingCalendarDateKey(balanceAsOf);
}

/**
 * normalize Owner Object Ids
 *
 * Performs logic operations for normalizeOwnerObjectIds.
 *
 * @param associatedOwnerIds - Request/input argument
 * @returns Operations result
 */
function normalizeOwnerObjectIds(associatedOwnerIds) {
  const out = [];
  for (const id of associatedOwnerIds || []) {
    if (id == null) continue;
    const s = String(id);
    if (!mongoose.Types.ObjectId.isValid(s) || s.length !== 24) continue;
    out.push(new mongoose.Types.ObjectId(s));
  }
  return out;
}

/** Full-unpaid Pending / Overdue schedule row - fee/dates may be rescheduled. */
function isFullUnpaidOpenSchedule(inv) {
  const st = String(inv.status || '');
  const open =
    st === String(INVOICE_STATUS.PENDING) || st === String(INVOICE_STATUS.OVERDUE);
  return open && Number(inv.alreadyPaid || 0) === 0 && Number(inv.balanceDue || 0) > 0;
}

/** Full-unpaid Pending only (future excess months may be removed) */
function isFullUnpaidPending(inv) {
  return (
    String(inv.status || '') === String(INVOICE_STATUS.PENDING) &&
    Number(inv.alreadyPaid || 0) === 0 &&
    Number(inv.balanceDue || 0) > 0
  );
}

/**
 * Recalculate future/unpaid schedule invoices for a single unit after fee or tenure change.
 * Preserves paid, partial, and historical invoices.
 */
async function recalculateFutureScheduleInvoicesForUnit(unit, { session } = {}) {
  const fee = Number(unit.monthlyRecurringFee);
  if (!unit._id || !Number.isFinite(fee) || fee <= 0) {
    return { updatedInvoices: 0, createdInvoices: 0, removedInvoices: 0 };
  }

  const unitIdStr = String(unit._id);
  if (!mongoose.Types.ObjectId.isValid(unitIdStr) || unitIdStr.length !== 24) {
    return { updatedInvoices: 0, createdInvoices: 0, removedInvoices: 0 };
  }
  const safeUnitId = new mongoose.Types.ObjectId(unitIdStr);

  const prevRp =
    unit.requestPayload && typeof unit.requestPayload === 'object' && !Array.isArray(unit.requestPayload)
      ? { ...unit.requestPayload }
      : {};
  let hoaSettings = null;
  if (unit.hoaId) {
    hoaSettings = await HOASettings.findOne({ hoaId: unit.hoaId }).select('paymentTerm').lean();
  }
  const effDueDay = resolvePaymentDueDayFromSources({
    requestPayload: prevRp,
    hoaSettings,
  });
  const desiredMonths = snapPaymentTermMonthsToSchema(unit.paymentTerm);
  const effFee = round2(fee);
  const todayStr = getDateKeyInTimeZone(ClockService.now());

  const ymd = balanceAsOfToYmd(unit.balanceAsOf);
  const parts = ymd ? parseDateOnlyToUtcParts(ymd) : null;
  if (!parts) {
    return { updatedInvoices: 0, createdInvoices: 0, removedInvoices: 0 };
  }

  const firstDue = firstMonthlyDueDateUtc(parts, effDueDay);
  const ownerIdsRaw = normalizeOwnerObjectIds(unit.associatedOwnerIds);

  let invQuery = Invoice.find({
    propertyId: safeUnitId,
    generatedFrom: 'unit_schedule',
    isDeleted: { $ne: true },
  }).sort({ dueDate: 1 });
  if (session) invQuery = invQuery.session(session);
  const invDocs = await invQuery.lean();

  const byMonth = new Map();
  for (const inv of invDocs) {
    let monthNum = getScheduleMonthNumber(inv.dueDate, firstDue);
    if (!monthNum) {
      const m = /^Month\s+(\d+)$/i.exec(inv.term || '');
      if (m) monthNum = Number(m[1]);
    }
    if (!Number.isFinite(monthNum) || monthNum < 1) continue;
    if (!byMonth.has(monthNum)) byMonth.set(monthNum, inv);
  }

  const unitLabel =
    (unit.unitDetails && unit.unitDetails[0] && unit.unitDetails[0].unitName) || unit.name || 'Unit';
  const propertyName = unit.name || 'Property';

  let updatedInvoices = 0;
  let createdInvoices = 0;
  let removedInvoices = 0;
  const createdInvoiceDocs = [];

  for (let k = 1; k <= desiredMonths; k += 1) {
    const newDue = addUtcCalendarMonths(firstDue, k - 1);
    const inv = byMonth.get(k);

    if (inv) {
      if (!isFullUnpaidOpenSchedule(inv)) continue;

      const updateOpts = session ? { session } : {};
      // eslint-disable-next-line no-await-in-loop
      await Invoice.updateOne(
        { _id: inv._id },
        {
          $set: {
            dueDate: newDue,
            subAmount: effFee,
            balanceDue: effFee,
            'invoiceItemDetails.0.rate': effFee,
            'invoiceItemDetails.0.amount': effFee,
          },
        },
        updateOpts,
      );
      updatedInvoices += 1;
      continue;
    }

    if (ownerIdsRaw.length === 0) continue;

    const cmpDue = compareCalendarDateToToday(newDue, ClockService.now());
    const initialStatus = cmpDue < 0 ? INVOICE_STATUS.OVERDUE : INVOICE_STATUS.PENDING;

    const invoiceIdAssigned = await allocateUniqueInvoiceId();
    const scheduled = new Invoice({
      invoiceId: invoiceIdAssigned,
      type: INVOICE_TYPES.FEES,
      status: initialStatus,
      propertyId: safeUnitId,
      hoaId: unit.hoaId || undefined,
      propertyName,
      unit: unitLabel,
      term: formatTermFromDate(newDue),
      tenants: ownerIdsRaw,
      invoiceItemDetails: [
        {
          invoiceItem: 'Monthly Fee',
          description: `Monthly recurring fee (schedule ${formatTermFromDate(newDue)}, added after fee update).`,
          quantity: 1,
          rate: effFee,
          amount: effFee,
        },
      ],
      subAmount: effFee,
      alreadyPaid: 0,
      balanceDue: effFee,
      isPartialPaymentAllowed: true,
      dueDate: newDue,
      notes: '',
      generatedFrom: 'unit_schedule',
    });
    if (session) {
      // eslint-disable-next-line no-await-in-loop
      await scheduled.save({ session });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await scheduled.save();
    }
    createdInvoices += 1;
    createdInvoiceDocs.push(scheduled);
  }

  const excessIds = [];
  for (const inv of invDocs) {
    let monthNum = getScheduleMonthNumber(inv.dueDate, firstDue);
    if (!monthNum) {
      const m = /^Month\s+(\d+)$/i.exec(inv.term || '');
      if (m) monthNum = Number(m[1]);
    }
    if (!Number.isFinite(monthNum) || monthNum <= desiredMonths) continue;
    const dueKey = billingCalendarDateKey(inv.dueDate);
    const futureOk = Boolean(dueKey && todayStr && dueKey > todayStr);
    if (!(futureOk && isFullUnpaidPending(inv))) continue;
    excessIds.push(inv._id);
  }

  if (excessIds.length > 0) {
    const updateOpts = session ? { session } : {};
    // eslint-disable-next-line no-await-in-loop
    const res = await Invoice.updateMany(
      { _id: { $in: excessIds }, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: ClockService.now() } },
      updateOpts,
    );
    removedInvoices += res.modifiedCount || excessIds.length;
  }

  return { updatedInvoices, createdInvoices, removedInvoices };
}

/**
 * After HOA recurring-fee / due-day / tenure settings change:
 * - Sync each unit billing snapshot (`monthlyRecurringFee`, `paymentTerm`, due day).
 * - **Update** full-unpaid monthly schedule rows (by due date) (**Pending / Overdue**, no payments applied) - `dueDate`, fee.
 * - **Create** any missing monthly rows when tenure extends (K = `paymentTerm` months).
 * - **Soft-delete** only excess future schedule rows that are full-unpaid and Pending - never touch paid/partial/overdue history.
 *
 * @param {string} hoaId
 * @param {object} mergedSettings - saved HOA settings document ({ recurringFee, paymentTerm })
 * @returns {Promise<{ updatedInvoices: number; createdInvoices: number; removedInvoices: number; updatedUnits: number }>}
 */
async function recalculateFutureScheduleInvoicesForHoa(hoaId, mergedSettings = {}) {
  const fee = Number(mergedSettings.recurringFee && mergedSettings.recurringFee.amount);
  const dueDaySrc = mergedSettings.paymentTerm && mergedSettings.paymentTerm.dueDay;
  const tenureYears = mergedSettings.recurringFee && mergedSettings.recurringFee.tenure != null
    ? Number(mergedSettings.recurringFee.tenure)
    : NaN;

  if (!hoaId || !Number.isFinite(fee) || fee <= 0) {
    return {
      updatedInvoices: 0,
      createdInvoices: 0,
      removedInvoices: 0,
      updatedUnits: 0,
    };
  }

  const hoTermMonthsSnap =
    Number.isFinite(tenureYears) && tenureYears > 0
      ? snapPaymentTermMonthsToSchema(tenureYears * 12)
      : null;

  const dueDaySetting = Number.isFinite(Number(dueDaySrc))
    ? Math.min(31, Math.max(1, Math.floor(Number(dueDaySrc))))
    : null;

  const hoaOid = mongoose.Types.ObjectId.isValid(String(hoaId))
    ? new mongoose.Types.ObjectId(String(hoaId))
    : null;
  if (!hoaOid) {
    return {
      updatedInvoices: 0,
      createdInvoices: 0,
      removedInvoices: 0,
      updatedUnits: 0,
    };
  }

  const units = await Property.find({ hoaId: hoaOid, isDeleted: { $ne: true } }).lean();

  let updatedInvoices = 0;
  let createdInvoices = 0;
  let removedInvoices = 0;
  let updatedUnits = 0;

  const effFee = round2(fee);

  for (const unit of units) {
    const prevRp =
      unit.requestPayload && typeof unit.requestPayload === 'object' && !Array.isArray(unit.requestPayload)
        ? { ...unit.requestPayload }
        : {};

    let effDueDay = dueDaySetting;
    if (effDueDay == null) {
      effDueDay = resolvePaymentDueDayFromSources({
        requestPayload: prevRp,
      });
    }
    prevRp.paymentDueDay = effDueDay;

    const desiredMonths =
      hoTermMonthsSnap != null
        ? hoTermMonthsSnap
        : snapPaymentTermMonthsToSchema(unit.paymentTerm);

    const setDoc = {
      monthlyRecurringFee: effFee,
      requestPayload: prevRp,
      paymentTerm: desiredMonths,
    };

    // eslint-disable-next-line no-await-in-loop
    await Property.updateOne({ _id: unit._id }, { $set: setDoc });
    updatedUnits += 1;

    const syncedUnit = { ...unit, ...setDoc, requestPayload: prevRp };
    // eslint-disable-next-line no-await-in-loop
    const unitResult = await recalculateFutureScheduleInvoicesForUnit(syncedUnit);
    updatedInvoices += unitResult.updatedInvoices;
    createdInvoices += unitResult.createdInvoices;
    removedInvoices += unitResult.removedInvoices;
  }

  return { updatedInvoices, createdInvoices, removedInvoices, updatedUnits };
}

module.exports = { recalculateFutureScheduleInvoicesForHoa, recalculateFutureScheduleInvoicesForUnit };
