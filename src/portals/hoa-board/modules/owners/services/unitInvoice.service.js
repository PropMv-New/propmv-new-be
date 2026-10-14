/**
 * ------------------------------------------------------------------
 * File: unitInvoice.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * invoicePolicyTerm.service, invoiceScheduleMeta.service, unit.service, unitScheduleRecalc.service
 * ------------------------------------------------------------------
 */

const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const logger = require('../../../../../common/logger');
const { INVOICE_TYPES, INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { ClockService, DateUtil } = require('../../../../../common/date');
const {
  compareCalendarDateToToday,
  isDueDateOnOrBeforeToday,
  formatMonthYearInAppTimezone,
  formatDateInAppTimezone,
  billingCalendarDateKey,
  parseDateOnlyToNoonUtc,
  lastDayOfAppMonth,
} = require('../../../../../common/helpers/hoaBillingDates');
const { allocateUniqueInvoiceIds, makeInvoiceId } = require('../../invoice/helpers/invoiceId.helper');
const { resolvePaymentDueDayFromSources } = require('../helpers/paymentDueDay.helper');
const { buildCreditAppliedPaymentTransaction } = require('../../invoice/helpers/invoiceCreditPayment.helper');

const formatTermFromDate = (date) => formatMonthYearInAppTimezone(date, { longMonth: true });

/**
 * Calendar Y/M/D for billing anchors (balanceAsOf, due dates).
 * YYYY-MM-DD and UTC-midnight Joi dates keep their UTC calendar day - never shift
 * back a day via America/New_York (Aug 10T00:00Z must stay Aug 10).
 */
const parseDateOnlyToUtcParts = (value) => {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
    }
  }
  const key = billingCalendarDateKey(value);
  if (!key) return null;
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
};

const roundCurrency = (value) => Number((value || 0).toFixed(2));

const normalizeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Due day in a calendar month (YMD parts), clamped and stored as noon UTC. */
const utcDueDateInMonth = (year, month0, dueDay) => {
  const clampedDue = Math.min(31, Math.max(1, Math.floor(Number(dueDay) || 1)));
  const month1 = month0 + 1;
  const last = lastDayOfAppMonth(year, month1);
  const day = Math.min(clampedDue, last);
  return parseDateOnlyToNoonUtc(`${year}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
};

/**
 * First monthly fee due date: due day in balance-as-of month, unless balance-as-of is *after*
 * that due date - then first due is due day in the following month.
 */
const firstMonthlyDueDateUtc = (balanceParts, dueDay) => {
  const { year, month, day } = balanceParts;
  const candidate = utcDueDateInMonth(year, month, dueDay);
  const balance = parseDateOnlyToNoonUtc(
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
  if (balance && balance.getTime() > candidate.getTime()) {
    const nextM = month + 1;
    const ny = nextM > 11 ? year + 1 : year;
    const nm = nextM > 11 ? 0 : nextM;
    return utcDueDateInMonth(ny, nm, dueDay);
  }
  return candidate;
};

const addUtcCalendarMonths = (dateUtc, n) => {
  if (!n) return DateUtil.fromEpoch(dateUtc.getTime());
  const key = billingCalendarDateKey(dateUtc);
  if (!key) return DateUtil.fromEpoch(dateUtc.getTime());
  const [yStr, mStr, dStr] = key.split('-');
  const y = Number(yStr);
  const m0 = Number(mStr) - 1;
  const d = Number(dStr);
  const targetM = m0 + n;
  const ty = y + Math.floor(targetM / 12);
  const tm = ((targetM % 12) + 12) % 12;
  const last = lastDayOfAppMonth(ty, tm + 1);
  const td = Math.min(d, last);
  return parseDateOnlyToNoonUtc(`${ty}-${String(tm + 1).padStart(2, '0')}-${String(td).padStart(2, '0')}`);
};
/**
 * Generate invoices for a unit on creation.
 *
 * Credit application strategy (FIFO, date-aware):
 *  - startingBalance > 0 → one opening-balance "Past Due Balance" row dated at balanceAsOf
 *    (contributes to outstanding totals; skipAutoLateFees - not a PropMv bill)
 *  - startingBalance < 0 → credit pool applied FIFO only to invoices whose
 *    dueDate <= today; future invoices stay PENDING with alreadyPaid = 0
 *
 * Returns { invoices, remainingCredit } so the caller can persist the leftover.
 */
const generateUnitInvoices = async (unitData, propertyId, propertyName, session, options = {}) => {
  const {
    balanceAsOf,
    monthlyRecurringFee,
    paymentTerm,
    paymentDueDay,
    startingBalance = 0,
    associatedOwnerIds = []
  } = unitData;
  const { includeOpeningBalanceInvoice = true, today = ClockService.now(), createdBy: optionCreatedBy } = options;

  const actorId = unitData.createdBy || unitData.hoaBoardMemberId || optionCreatedBy;
  const invoiceActorFields = actorId ? { createdBy: actorId } : {};
  const invoiceHoaFields = unitData.hoaId ? { hoaId: unitData.hoaId } : {};

  const fee = roundCurrency(normalizeNumber(monthlyRecurringFee));
  const terms = normalizeNumber(paymentTerm);
  const opening = roundCurrency(normalizeNumber(startingBalance));
  const dueDaySetting = resolvePaymentDueDayFromSources({ explicitDay: paymentDueDay });

  if (!balanceAsOf || fee <= 0 || terms <= 0 || !associatedOwnerIds.length) {
    logger.info('[generateUnitInvoices] skipped - missing required fields');
    return { invoices: [], remainingCredit: 0 };
  }

  const opts = session ? { session } : {};
  let depositBankFields = {};
  const propertyBankQuery = Property.findById(propertyId).select('depositBankAccountId depositBankAccountName');
  const propertyBankDoc = session
    ? await propertyBankQuery.session(session).lean()
    : await propertyBankQuery.lean();
  if (propertyBankDoc?.depositBankAccountId) {
    depositBankFields = {
      depositBankAccountId: propertyBankDoc.depositBankAccountId,
      depositBankAccountName: String(propertyBankDoc.depositBankAccountName || '').trim().slice(0, 200),
    };
  }

  const dateParts = parseDateOnlyToUtcParts(balanceAsOf);
  if (!dateParts) {
    logger.info('[generateUnitInvoices] skipped - invalid balanceAsOf');
    return { invoices: [], remainingCredit: 0 };
  }

  const invoiceDocs = [];
  const totalToCreate = (includeOpeningBalanceInvoice && opening > 0 ? 1 : 0) + terms;
  const invoiceIds = totalToCreate > 0
    ? await allocateUniqueInvoiceIds(totalToCreate, { session })
    : [];
  let invoiceIdIndex = 0;

  // ── 1. Opening / carried balance invoice (positive starting balance only)
  if (includeOpeningBalanceInvoice && opening > 0) {
    const pastDueDate = parseDateOnlyToNoonUtc(
      `${dateParts.year}-${String(dateParts.month + 1).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`,
    );
    const balanceDayVsToday = compareCalendarDateToToday(pastDueDate, today);
    const openingStatus =
      balanceDayVsToday < 0 ? INVOICE_STATUS.OVERDUE : INVOICE_STATUS.PENDING;
    invoiceDocs.push({
      invoiceId: invoiceIds[invoiceIdIndex++],
      type: INVOICE_TYPES.FEES,
      status: openingStatus,
      propertyId,
      propertyName,
      unit: unitData.title || 'Unit',
      term: 'Past Due Balance',
      tenants: associatedOwnerIds,
      invoiceItemDetails: [{
        invoiceItem: 'Past Due Balance',
        description: `Outstanding balance carried forward as of ${formatDateInAppTimezone(pastDueDate, { month: 'long', day: 'numeric', year: 'numeric' })}`,
        quantity: 1,
        rate: opening,
        amount: opening
      }],
      subAmount: opening,
      principalSubAmount: opening,
      alreadyPaid: 0,
      balanceDue: opening,
      isPartialPaymentAllowed: true,
      dueDate: pastDueDate,
      notes: `Past due balance from before unit was added to the system. Original balance as of ${balanceAsOf}.`,
      generatedFrom: 'opening_balance',
      skipAutoLateFees: true,
      ...invoiceActorFields,
      ...invoiceHoaFields,
      ...depositBankFields,
    });
  }

  // ── 2. Monthly fee invoices ───────────────────────────────────────────────
  let remainingCredit = opening < 0 ? roundCurrency(Math.abs(opening)) : 0;
  const firstMonthlyDue = firstMonthlyDueDateUtc(dateParts, dueDaySetting);

  for (let i = 0; i < terms; i++) {
    const dueDate = addUtcCalendarMonths(firstMonthlyDue, i);
    const isDue = isDueDateOnOrBeforeToday(dueDate, today);

    let appliedCredit = 0;
    let balanceDue = fee;
    let status = INVOICE_STATUS.PENDING;
    let notes = '';
    let paidOn;

    if (isDue && remainingCredit > 0) {
      appliedCredit = roundCurrency(Math.min(fee, remainingCredit));
      balanceDue = roundCurrency(fee - appliedCredit);
      remainingCredit = roundCurrency(remainingCredit - appliedCredit);

      status = balanceDue === 0
        ? INVOICE_STATUS.PAID
        : INVOICE_STATUS.PARTIALLY_PAID;

      const noteParts = [
        appliedCredit > 0 ? `Credit applied: $${appliedCredit.toFixed(2)}` : null,
        remainingCredit > 0 ? `Remaining credit: $${remainingCredit.toFixed(2)}` : null
      ].filter(Boolean);
      notes = noteParts.join(' | ');

      if (status === INVOICE_STATUS.PAID) paidOn = ClockService.now();
    }

    const creditPaymentTx =
      appliedCredit > 0
        ? buildCreditAppliedPaymentTransaction({
          amount: appliedCredit,
          balanceAfter: balanceDue,
          paidAt: paidOn || ClockService.now(),
        })
        : null;

    invoiceDocs.push({
      invoiceId: invoiceIds[invoiceIdIndex++],
      type: INVOICE_TYPES.FEES,
      status,
      propertyId,
      propertyName,
      unit: unitData.title || 'Unit',
      term: formatTermFromDate(dueDate),
      tenants: associatedOwnerIds,
      invoiceItemDetails: [{
        invoiceItem: 'Monthly Fee',
        description: 'Monthly Recurring Fee',
        quantity: 1,
        rate: fee,
        amount: fee
      }],
      subAmount: fee,
      principalSubAmount: fee,
      alreadyPaid: appliedCredit,
      balanceDue,
      isPartialPaymentAllowed: true,
      dueDate,
      notes,
      generatedFrom: 'unit_schedule',
      ...invoiceActorFields,
      ...invoiceHoaFields,
      ...depositBankFields,
      ...(paidOn && { paidOn }),
      ...(creditPaymentTx ? { paymentTransactions: [creditPaymentTx] } : {}),
    });
  }

  let invoices = [];
  if (invoiceDocs.length > 0) {
    invoices = await Invoice.insertMany(invoiceDocs, { ...opts, ordered: true });
  }

  logger.info(
    `[generateUnitInvoices] created ${invoices.length} invoices (due day ${dueDaySetting}) - remainingCredit: $${remainingCredit.toFixed(2)}`
  );
  if (invoices.length > 0) {
    await Property.findByIdAndUpdate(propertyId, { $set: { hasGeneratedInvoices: true } }, opts);
  }
  return { invoices, remainingCredit };
};

module.exports = {
  generateUnitInvoices,
  parseDateOnlyToUtcParts,
  firstMonthlyDueDateUtc,
  utcDueDateInMonth,
  addUtcCalendarMonths,
  makeInvoiceId,
};
