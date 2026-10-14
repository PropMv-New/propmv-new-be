const { ClockService, DateUtil } = require('../../../../../common/date');
/**
 * ------------------------------------------------------------------
 * File: invoiceCreditPayment.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoiceCreditPayment.helper.
 *
 * Used By:
 * invoicePolicyTerm.service, ledger.service, unitInvoice.service
 * ------------------------------------------------------------------
 */

/**
 * Build a paymentTransactions row when HOA credit is applied to an invoice.
 */
function buildCreditAppliedPaymentTransaction({
  amount,
  balanceAfter,
  paidAt,
  note,
  source = 'credit_balance',
  sourcePaymentGroupId,
  sourceInvoiceId,
  sourceInvoiceNumber,
}) {
  const apply = Number((Number(amount) || 0).toFixed(2));
  const balance = Number((Number(balanceAfter) || 0).toFixed(2));
  const when = DateUtil.toUTC(paidAt) || ClockService.now();
  const defaultNote =
    source === 'prepaid_pool'
      ? `Prepaid credit applied: $${apply.toFixed(2)}`
      : `Applied $${apply.toFixed(2)} from available credit balance`;

  const tx = {
    amount: apply,
    method: 'Credit Adjustment',
    note: note || defaultNote,
    balanceAfter: balance,
    paidAt: when,
    recordedAt: when,
  };
  if (sourcePaymentGroupId) tx.sourcePaymentGroupId = String(sourcePaymentGroupId);
  if (sourceInvoiceId) tx.sourceInvoiceId = sourceInvoiceId;
  if (sourceInvoiceNumber) tx.sourceInvoiceNumber = String(sourceInvoiceNumber);
  return tx;
}

module.exports = {
  buildCreditAppliedPaymentTransaction,
};
