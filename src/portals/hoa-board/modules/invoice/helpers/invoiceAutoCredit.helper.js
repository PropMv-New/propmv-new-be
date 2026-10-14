/**
 * ------------------------------------------------------------------
 * File: invoiceAutoCredit.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoiceAutoCredit.helper.
 *
 * Used By:
 * invoice.service, ledger.service
 * ------------------------------------------------------------------
 */

const { getTodayStartAndTomorrowStart } = require('../../../../../common/helpers/hoaBillingDates');
const { ClockService, DateUtil } = require('../../../../../common/date');

/**
 * Start of the next HOA calendar day - legacy date-based pause window.
 * Prefer `skipAutoCreditApply` for sticky pauses after manual removal.
 * @returns {Date|null}
 */
function getSkipAutoCreditUntilNextDay(timeZone) {
  const { tomorrowStart } = getTodayStartAndTomorrowStart(timeZone);
  return tomorrowStart || null;
}

/**
 * True when automatic credit application must skip this invoice.
 * Sticky boolean (manual removal) takes precedence; legacy `skipAutoCreditUntil` still honored.
 * @param {{ skipAutoCreditApply?: boolean, skipAutoCreditUntil?: Date|string|null }} invoice
 * @param {Date} [now]
 */
function isInvoiceAutoCreditPaused(invoice, now = ClockService.now()) {
  if (invoice?.skipAutoCreditApply === true) return true;
  if (!invoice?.skipAutoCreditUntil) return false;
  const until = DateUtil.toUTC(invoice.skipAutoCreditUntil);
  if (!until) return false;
  return until.getTime() > now.getTime();
}

/** Mark invoice so auto-credit will not reapply until explicitly applied again. */
function markInvoiceSkipAutoCredit(invoice) {
  if (!invoice) return;
  invoice.skipAutoCreditApply = true;
  invoice.skipAutoCreditUntil = undefined;
}

/** Clear pause so auto-credit (and future cycles) may apply again. */
function clearInvoiceSkipAutoCredit(invoice) {
  if (!invoice) return;
  invoice.skipAutoCreditApply = false;
  invoice.skipAutoCreditUntil = undefined;
}

module.exports = {
  getSkipAutoCreditUntilNextDay,
  isInvoiceAutoCreditPaused,
  markInvoiceSkipAutoCredit,
  clearInvoiceSkipAutoCredit,
};
