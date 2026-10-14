/**
 * ------------------------------------------------------------------
 * File: openingBalanceInvoice.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for openingBalanceInvoice.helper.
 *
 * Used By:
 * unitLateFee.service
 * ------------------------------------------------------------------
 */

/** Carried-forward balance from unit/property onboarding - not a PropMv-generated bill. */
const OPENING_BALANCE_INVOICE_TERM = 'Past Due Balance';

/**
 * Opening / migrated balances must contribute to outstanding totals but must not
 * participate in automatic late-fee, recurring late-fee, or invoice due-date logic.
 */
function isOpeningBalanceInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object') return false;
  if (String(invoice.generatedFrom || '') === 'opening_balance') return true;
  return String(invoice.term || '').trim() === OPENING_BALANCE_INVOICE_TERM;
}

module.exports = {
  OPENING_BALANCE_INVOICE_TERM,
  isOpeningBalanceInvoice,
};
