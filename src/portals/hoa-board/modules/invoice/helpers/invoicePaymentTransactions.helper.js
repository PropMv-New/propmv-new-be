/**
 * ------------------------------------------------------------------
 * File: invoicePaymentTransactions.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoicePaymentTransactions.helper.
 *
 * Used By:
 * invoiceCreditReconcile.helper, invoicePaymentReversal.helper, invoice.service, ledger.service
 * ------------------------------------------------------------------
 */
const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));

const PAYMENT_TX_STATUS = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const CREDIT_APPLIED_METHOD = 'credit adjustment';
const CREDIT_RETURN_METHOD = 'credit returned';
const CREDIT_STORED_METHOD = 'credit balance';
const ELECTRONIC_PAYMENT_METHODS = new Set([
  'ACH',
  'bank transfer',
  'card',
  'credit card',
  'debit card',
  'e-check',
  'echeck',
  // Check21 gateway only — offline manual "Check" (check number) must stay non-electronic
  'check21',
]);

/**
 * normalize Method
 *
 * Performs logic operations for normalizeMethod.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function normalizeMethod(tx) {
  return String(tx?.method || '').trim().toLowerCase();
}

/**
 * normalize Note
 *
 * Performs logic operations for normalizeNote.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function normalizeNote(tx) {
  return String(tx?.note || '').trim().toLowerCase();
}

/**
 * is Deleted Payment Transaction
 *
 * Performs logic operations for isDeletedPaymentTransaction.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function isDeletedPaymentTransaction(tx) {
  return tx?.isDeleted === true;
}

function getPaymentTransactionStatus(tx) {
  return String(tx?.status || PAYMENT_TX_STATUS.COMPLETED).toLowerCase();
}

function isProcessingPaymentTransaction(tx) {
  if (isDeletedPaymentTransaction(tx)) return false;
  return getPaymentTransactionStatus(tx) === PAYMENT_TX_STATUS.PROCESSING;
}

function isCompletedPaymentTransaction(tx) {
  if (isDeletedPaymentTransaction(tx)) return false;
  const status = getPaymentTransactionStatus(tx);
  return status === PAYMENT_TX_STATUS.COMPLETED;
}

/**
 * New gateway rows are explicitly marked non-manual. Method/note detection also
 * protects legacy Stripe/ACH rows created before the flag was introduced.
 */
function isElectronicPaymentTransaction(tx) {
  if (tx?.isManual === false) return true;
  if (ELECTRONIC_PAYMENT_METHODS.has(normalizeMethod(tx))) return true;
  return /\b(stripe|straddle|payment gateway)\b/.test(normalizeNote(tx));
}

/**
 * active Payment Transactions
 *
 * Performs logic operations for activePaymentTransactions.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function activePaymentTransactions(invoice) {
  return (Array.isArray(invoice?.paymentTransactions) ? invoice.paymentTransactions : [])
    .filter((tx) => !isDeletedPaymentTransaction(tx));
}

/**
 * is Credit Stored Overpayment Transaction
 *
 * Performs logic operations for isCreditStoredOverpaymentTransaction.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function isCreditStoredOverpaymentTransaction(tx) {
  if (isDeletedPaymentTransaction(tx)) return false;
  return (
    normalizeMethod(tx) === CREDIT_STORED_METHOD
    && normalizeNote(tx).includes('stored as credit balance')
  );
}

/**
 * is Credit Return Transaction
 *
 * Performs logic operations for isCreditReturnTransaction.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function isCreditReturnTransaction(tx) {
  if (isDeletedPaymentTransaction(tx)) return false;
  return normalizeMethod(tx) === CREDIT_RETURN_METHOD;
}

/**
 * is Credit Applied Transaction
 *
 * Performs logic operations for isCreditAppliedTransaction.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function isCreditAppliedTransaction(tx) {
  if (isDeletedPaymentTransaction(tx)) return false;
  if (isCreditStoredOverpaymentTransaction(tx) || isCreditReturnTransaction(tx)) return false;
  return normalizeMethod(tx) === CREDIT_APPLIED_METHOD;
}

/**
 * is Payment Toward Invoice Transaction
 *
 * Performs logic operations for isPaymentTowardInvoiceTransaction.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function isPaymentTowardInvoiceTransaction(tx) {
  if (isDeletedPaymentTransaction(tx)) return false;
  if (isProcessingPaymentTransaction(tx)) return false;
  return !isCreditStoredOverpaymentTransaction(tx);
}

/**
 * get Payment Transaction Net Toward Invoice
 *
 * Performs logic operations for getPaymentTransactionNetTowardInvoice.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function getPaymentTransactionNetTowardInvoice(tx) {
  if (isDeletedPaymentTransaction(tx)) return 0;
  if (!isPaymentTowardInvoiceTransaction(tx)) return 0;
  if (isCreditReturnTransaction(tx)) return -Number(tx.amount || 0);
  const gross = Number(tx.amount || 0);
  const refunded = roundMoney(tx.refundedAmount || 0);
  if (tx.refundedAt && refunded + 0.009 >= gross) return 0;
  return roundMoney(Math.max(0, gross - refunded));
}

/**
 * sum Credit Applied On Invoice
 *
 * Performs logic operations for sumCreditAppliedOnInvoice.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function sumCreditAppliedOnInvoice(invoice) {
  const txs = activePaymentTransactions(invoice);
  return roundMoney(
    txs.reduce((sum, tx) => {
      if (isCreditReturnTransaction(tx)) return sum - Number(tx.amount || 0);
      if (isCreditAppliedTransaction(tx)) return sum + Number(tx.amount || 0);
      return sum;
    }, 0)
  );
}

/**
 * sum Credit Stored On Invoice
 *
 * Performs logic operations for sumCreditStoredOnInvoice.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function sumCreditStoredOnInvoice(invoice) {
  const txs = activePaymentTransactions(invoice);
  return roundMoney(
    txs
      .filter((tx) => isCreditStoredOverpaymentTransaction(tx))
      .reduce((sum, tx) => sum + Number(tx.amount || 0), 0)
  );
}

function sumProcessingAmountOnInvoice(invoice) {
  const txs = activePaymentTransactions(invoice);
  return roundMoney(
    txs
      .filter(isProcessingPaymentTransaction)
      .reduce((sum, tx) => sum + Number(tx.amount || 0), 0)
  );
}

/**
 * recalculate Invoice Totals From Transactions
 *
 * Performs logic operations for recalculateInvoiceTotalsFromTransactions.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function recalculateInvoiceTotalsFromTransactions(invoice) {
  const subAmount = roundMoney(invoice?.subAmount || 0);
  const waivedAmount = roundMoney(invoice?.waivedAmount || 0);
  const processingAmount = sumProcessingAmountOnInvoice(invoice);
  const netPaid = roundMoney(
    (invoice?.paymentTransactions || []).reduce(
      (sum, tx) => sum + getPaymentTransactionNetTowardInvoice(tx),
      0
    )
  );
  const alreadyPaid = roundMoney(Math.min(subAmount, Math.max(0, netPaid)));
  const balanceDue = roundMoney(Math.max(0, subAmount - alreadyPaid - processingAmount - waivedAmount));
  return { alreadyPaid, processingAmount, balanceDue };
}

function deriveInvoiceOpenBalanceFromScalars(invoice) {
  return roundMoney(
    Math.max(
      0,
      Number(invoice?.subAmount || 0)
      - Number(invoice?.alreadyPaid || 0)
      - Number(invoice?.processingAmount || 0)
      - Number(invoice?.waivedAmount || 0)
    )
  );
}

/** Open balance for pay / allocation (source of truth: txs, then scalar fields). */
function getInvoiceCollectableBalance(invoice) {
  if (!invoice) return 0;
  removeStaleDuplicateGatewayProcessingRows(invoice);

  const stored = roundMoney(Math.max(0, Number(invoice.balanceDue || 0)));
  const derived = deriveInvoiceOpenBalanceFromScalars(invoice);
  const txs = invoice.paymentTransactions;

  if (Array.isArray(txs) && txs.length > 0) {
    return recalculateInvoiceTotalsFromTransactions(invoice).balanceDue;
  }

  const subAmount = roundMoney(Number(invoice.subAmount || 0));
  const alreadyPaid = roundMoney(Number(invoice.alreadyPaid || 0));
  const processingAmount = roundMoney(Number(invoice.processingAmount || 0));

  // Full in-flight payment without denormalized processing fields (legacy/list rows).
  if (
    stored <= 0
    && alreadyPaid <= 0
    && processingAmount <= 0
    && subAmount > 0
    && derived + 0.009 >= subAmount
  ) {
    return 0;
  }

  if (stored <= 0 && derived > 0) {
    return derived;
  }
  if (stored > 0) {
    if (derived > stored + 0.009) {
      return stored;
    }
    const waivedAmount = roundMoney(Number(invoice.waivedAmount || 0));
    // Active waiver: never trust a stale high balanceDue over identity.
    if (waivedAmount > 0) {
      return roundMoney(Math.min(stored, derived));
    }
    return roundMoney(Math.max(stored, derived));
  }
  return derived;
}

/**
 * Drop in-flight processing rows superseded by a completed gateway payment (same gateway ref).
 */
function removeStaleDuplicateGatewayProcessingRows(invoice) {
  if (!invoice || !Array.isArray(invoice.paymentTransactions)) {
    return { changed: false, invoice };
  }

  const txs = activePaymentTransactions(invoice);
  const completedKeys = new Set();
  for (const tx of txs) {
    if (!isCompletedPaymentTransaction(tx)) continue;
    if (tx.gatewayTransactionId) completedKeys.add(`id:${String(tx.gatewayTransactionId)}`);
    if (tx.gatewayExternalId) completedKeys.add(`ext:${String(tx.gatewayExternalId)}`);
  }

  let changed = false;
  for (const tx of invoice.paymentTransactions) {
    if (!isProcessingPaymentTransaction(tx)) continue;
    const idKey = tx.gatewayTransactionId ? `id:${String(tx.gatewayTransactionId)}` : '';
    const extKey = tx.gatewayExternalId ? `ext:${String(tx.gatewayExternalId)}` : '';
    const superseded = (idKey && completedKeys.has(idKey)) || (extKey && completedKeys.has(extKey));
    if (!superseded) continue;
    tx.isDeleted = true;
    tx.deletedAt = tx.deletedAt || new Date();
    tx.note = `${tx.note || ''} [auto-removed: duplicate in-flight gateway row]`.trim();
    changed = true;
  }

  if (!changed) return { changed: false, invoice };

  const totals = recalculateInvoiceTotalsFromTransactions(invoice);
  invoice.processingAmount = totals.processingAmount;
  invoice.alreadyPaid = totals.alreadyPaid;
  invoice.balanceDue = totals.balanceDue;
  return { changed: true, invoice, totals };
}

/**
 * classify Payment Transaction
 *
 * Performs logic operations for classifyPaymentTransaction.
 *
 * @param tx - Request/input argument
 * @returns Operations result
 */
function classifyPaymentTransaction(tx) {
  if (isCreditStoredOverpaymentTransaction(tx)) return 'credit_stored';
  if (isCreditReturnTransaction(tx)) return 'credit_returned';
  if (isCreditAppliedTransaction(tx)) return 'credit_applied';
  return 'payment';
}

module.exports = {
  roundMoney,
  PAYMENT_TX_STATUS,
  isDeletedPaymentTransaction,
  isProcessingPaymentTransaction,
  isCompletedPaymentTransaction,
  isElectronicPaymentTransaction,
  activePaymentTransactions,
  isCreditStoredOverpaymentTransaction,
  isCreditReturnTransaction,
  isCreditAppliedTransaction,
  isPaymentTowardInvoiceTransaction,
  getPaymentTransactionNetTowardInvoice,
  sumCreditAppliedOnInvoice,
  sumCreditStoredOnInvoice,
  sumProcessingAmountOnInvoice,
  recalculateInvoiceTotalsFromTransactions,
  getInvoiceCollectableBalance,
  deriveInvoiceOpenBalanceFromScalars,
  removeStaleDuplicateGatewayProcessingRows,
  classifyPaymentTransaction,
};
