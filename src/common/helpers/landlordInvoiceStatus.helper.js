/**
 * ------------------------------------------------------------------
 * File: landlordInvoiceStatus.helper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for landlordInvoiceStatus.helper.
 *
 * Used By:
 * invoice.model, invoice.service, lateFeeInvoice.helpers, lateFeeInvoice.service
 * ------------------------------------------------------------------
 */
const { INVOICE_STATUS } = require('../constants/invoice');
const { ClockService, DateUtil } = require('../date');
const {
  getDateKeyInTimeZone,
  parseDateOnlyToNoonUtc,
  compareCalendarDateToToday,
  getCalendarDaysLate,
} = require('./hoaBillingDates');

/** Noon-UTC anchor for the calendar day of `date` in the business timezone (EST). */
function startOfDay(date = ClockService.now()) {
  const key = getDateKeyInTimeZone(date);
  return parseDateOnlyToNoonUtc(key) || DateUtil.toUTC(date);
}

/**
 * get Days Past Due
 *
 * Performs logic operations for getDaysPastDue.
 *
 * @param dueDate - Request/input argument
 * @param referenceDate - Request/input argument
 * @returns Operations result
 */
function getDaysPastDue(dueDate, referenceDate = ClockService.now()) {
  if (!dueDate) return 0;
  return getCalendarDaysLate(dueDate, referenceDate);
}

/**
 * is Due Today
 *
 * Performs logic operations for isDueToday.
 *
 * @param dueDate - Request/input argument
 * @param referenceDate - Request/input argument
 * @returns Operations result
 */
function isDueToday(dueDate, referenceDate = ClockService.now()) {
  return compareCalendarDateToToday(dueDate, referenceDate) === 0;
}

/**
 * Derive persisted landlord invoice status from balances and due date.
 */
function deriveLandlordInvoiceStatus(invoice, referenceDate = ClockService.now()) {
  const balanceDue = Number(invoice?.balanceDue ?? 0);
  const subAmount = Number(invoice?.subAmount ?? 0);

  if (balanceDue <= 0.004) {
    return INVOICE_STATUS.PAID;
  }

  if (Math.abs(balanceDue - subAmount) <= 0.004) {
    return getDaysPastDue(invoice.dueDate, referenceDate) > 0
      ? INVOICE_STATUS.OVERDUE
      : INVOICE_STATUS.PENDING;
  }

  return getDaysPastDue(invoice.dueDate, referenceDate) > 0
    ? INVOICE_STATUS.OVERDUE
    : INVOICE_STATUS.PARTIALLY_PAID;
}

/**
 * is Open Landlord Invoice
 *
 * Performs logic operations for isOpenLandlordInvoice.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function isOpenLandlordInvoice(invoice) {
  const balanceDue = Number(invoice?.balanceDue ?? 0);
  return balanceDue > 0.004 && invoice?.isDeleted !== true;
}

/**
 * is Overdue Landlord Invoice
 *
 * Performs logic operations for isOverdueLandlordInvoice.
 *
 * @param invoice - Request/input argument
 * @param referenceDate - Request/input argument
 * @returns Operations result
 */
function isOverdueLandlordInvoice(invoice, referenceDate = ClockService.now()) {
  if (!isOpenLandlordInvoice(invoice)) return false;
  return getDaysPastDue(invoice.dueDate, referenceDate) > 0;
}

module.exports = {
  startOfDay,
  getDaysPastDue,
  isDueToday,
  deriveLandlordInvoiceStatus,
  isOpenLandlordInvoice,
  isOverdueLandlordInvoice,
};
