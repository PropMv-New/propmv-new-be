'use strict';

/**
 * Owner notices after a payment/credit row is removed.
 *
 * Payment-deleted (email + in-app) is sent once for the source invoice the user
 * acted on - matching payment-recorded, which also notifies once on the
 * recording invoice. Additional invoices touched by FIFO / credit reversal get
 * invoice-updated emails only, so the same unit owners are not shown duplicate
 * "payment removed" notifications.
 */

function roundCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatAuditCurrency(value) {
  return `$${roundCurrency(value).toFixed(2)}`;
}

function toIdString(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && value._id != null) return String(value._id);
  return String(value);
}

/**
 * @param {object} args
 * @param {object} args.invoice - Source invoice the payment was removed from
 * @param {string|null} args.userId
 * @param {string} args.paymentTransactionId
 * @param {object} args.tx - Original payment transaction (pre-delete snapshot fields)
 * @param {object|null} args.removedPayment - Result from reverseRecordedPaymentGroup / fallback
 * @param {string} args.removedTxKind
 * @param {number} args.removedCreditAmount
 * @param {boolean} args.isCreditApplicationRemoval
 * @param {object} deps - Injected notifiers (for tests)
 */
function notifyInvoicePaymentRemovalEffects(args = {}, deps = {}) {
  const {
    invoice,
    userId = null,
    paymentTransactionId = '',
    tx = {},
    removedPayment = null,
    removedTxKind = '',
    removedCreditAmount = 0,
    isCreditApplicationRemoval = false,
  } = args;

  const {
    notifyPaymentDeletedInBackground,
    notifyPaymentDeletedInAppInBackground,
    notifyInvoiceUpdatedInBackground,
  } = deps;

  if (typeof notifyPaymentDeletedInBackground !== 'function'
    || typeof notifyPaymentDeletedInAppInBackground !== 'function'
    || typeof notifyInvoiceUpdatedInBackground !== 'function') {
    throw new Error('notifyInvoicePaymentRemovalEffects requires notify dependencies');
  }

  if (!invoice) return { paymentDeletedNotices: 0, secondaryUpdateNotices: 0 };

  const removedAmount = roundCurrency(removedPayment?.totalRemoved || tx.amount || 0);
  const firstRemoved = removedPayment?.removedTransactions?.[0];
  const affectedInvoices = Array.isArray(removedPayment?.affectedInvoices) && removedPayment.affectedInvoices.length
    ? removedPayment.affectedInvoices
    : [invoice];

  notifyPaymentDeletedInBackground({
    invoice,
    paymentAmount: removedAmount,
    paymentMethod: firstRemoved?.method || tx.method || 'Payment',
    paidAt: firstRemoved?.paidAt || tx.paidAt,
    recordedByUserId: userId,
    paymentTransactionId,
  });
  notifyPaymentDeletedInAppInBackground(
    invoice,
    userId,
    removedAmount,
    String(paymentTransactionId || ''),
  );

  const sourceId = toIdString(invoice._id);
  const notifiedSecondary = new Set();
  let secondaryUpdateNotices = 0;

  for (const affected of affectedInvoices) {
    const affectedId = toIdString(affected?._id || affected);
    if (!affectedId || affectedId === sourceId || notifiedSecondary.has(affectedId)) continue;
    notifiedSecondary.add(affectedId);

    const removedForAffected = (removedPayment?.removedTransactions || []).find(
      (row) => toIdString(row.invoiceId) === affectedId
    );
    const amountForNotice = roundCurrency(
      removedForAffected?.amount || removedCreditAmount || 0
    );
    const affectedKind = removedForAffected?.kind || '';
    const isCreditUnapply =
      affectedKind === 'credit_applied'
      || (isCreditApplicationRemoval && removedTxKind === 'credit_applied');

    notifyInvoiceUpdatedInBackground({
      invoice: affected,
      recordedByUserId: userId,
      activityIntro: isCreditUnapply
        ? `A credit of ${formatAuditCurrency(amountForNotice)} applied to your invoice was removed because the source overpayment credit on another invoice was reversed.`
        : `A payment allocation of ${formatAuditCurrency(amountForNotice)} was reversed because the original payment on another invoice was removed.`,
    });
    secondaryUpdateNotices += 1;
  }

  return {
    paymentDeletedNotices: 1,
    secondaryUpdateNotices,
  };
}

module.exports = {
  notifyInvoicePaymentRemovalEffects,
  roundCurrency,
  formatAuditCurrency,
};
