'use strict';

const { PAYIN_STATUS, WEBHOOK_PROCESSING_STATUS } = require('../constants/payload.constants');

const RECONCILIATION_ISSUE = {
  PAYIN_SETTLED_MISSING_INVOICE_TX: 'payin_settled_missing_invoice_tx',
  PAYIN_SETTLED_MISSING_LEDGER: 'payin_settled_missing_ledger',
  INVOICE_TX_AMOUNT_MISMATCH: 'invoice_tx_amount_mismatch',
  PAYIN_RETURNED_STILL_COMPLETED: 'payin_returned_still_completed',
  PAYIN_IN_REVIEW_STALE: 'payin_in_review_stale',
  PAYIN_PROCESSING_STALE: 'payin_processing_stale',
  WEBHOOK_FAILED: 'webhook_failed',
};

const COMPLETED_TX_STATUS = new Set(['completed']);

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function findMatchingInvoicePaymentTx(paymentTransactions = [], { gatewayTransactionId, payinId } = {}) {
  const localId = String(gatewayTransactionId || '').trim();
  const externalId = String(payinId || '').trim();

  return (paymentTransactions || []).find((tx) => {
    const status = String(tx?.status || '').toLowerCase();
    if (!COMPLETED_TX_STATUS.has(status)) return false;
    if (localId && String(tx.gatewayTransactionId || '') === localId) return true;
    if (externalId && String(tx.gatewayExternalId || '') === externalId) return true;
    return false;
  }) || null;
}

function findProcessingInvoicePaymentTx(paymentTransactions = [], { gatewayTransactionId, payinId } = {}) {
  const localId = String(gatewayTransactionId || '').trim();
  const externalId = String(payinId || '').trim();

  return (paymentTransactions || []).find((tx) => {
    const status = String(tx?.status || '').toLowerCase();
    if (status !== 'processing') return false;
    if (localId && String(tx.gatewayTransactionId || '') === localId) return true;
    if (externalId && String(tx.gatewayExternalId || '') === externalId) return true;
    return false;
  }) || null;
}

function findMatchingLedgerPayment(ledgerEntries = [], { invoiceId, gatewayExternalId, amount } = {}) {
  const invoiceRef = String(invoiceId || '').trim();
  const externalId = String(gatewayExternalId || '').trim();
  const expectedAmount = roundMoney(amount);

  return (ledgerEntries || []).find((entry) => {
    if (String(entry?.type || '') !== 'payment') return false;
    if (invoiceRef && String(entry.referenceId || '') !== invoiceRef) return false;
    if (externalId && String(entry.metadata?.gatewayExternalId || '') !== externalId) return false;
    if (expectedAmount > 0 && roundMoney(Math.abs(Number(entry.amount || 0))) !== expectedAmount) {
      return false;
    }
    return true;
  }) || null;
}

function hoursSince(dateValue, nowMs = Date.now()) {
  if (!dateValue) return 0;
  const ts = new Date(dateValue).getTime();
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (nowMs - ts) / (1000 * 60 * 60));
}

function assessPayloadPayinRow({
  payin,
  invoice,
  ledgerEntries = [],
  staleInReviewHours = 72,
  staleProcessingHours = 168,
  nowMs = Date.now(),
} = {}) {
  const issues = [];
  if (!payin) return issues;

  const payinStatus = String(payin.status || '').toUpperCase();
  const payinId = payin.payinId || '';
  const gatewayTransactionId = payin._id ? String(payin._id) : String(payin.id || '');
  const invoicePaymentAmount = roundMoney(payin.invoicePaymentAmount);
  const paymentTransactions = invoice?.paymentTransactions || [];

  const completedTx = findMatchingInvoicePaymentTx(paymentTransactions, {
    gatewayTransactionId,
    payinId,
  });
  const processingTx = findProcessingInvoicePaymentTx(paymentTransactions, {
    gatewayTransactionId,
    payinId,
  });

  if (payinStatus === PAYIN_STATUS.SUCCEEDED) {
    if (!completedTx) {
      issues.push({
        code: RECONCILIATION_ISSUE.PAYIN_SETTLED_MISSING_INVOICE_TX,
        severity: 'high',
        payinId,
        invoiceId: String(payin.invoiceId || invoice?._id || ''),
        message: 'Payload payin is succeeded but invoice has no completed payment row.',
      });
    } else if (roundMoney(completedTx.amount) !== invoicePaymentAmount) {
      issues.push({
        code: RECONCILIATION_ISSUE.INVOICE_TX_AMOUNT_MISMATCH,
        severity: 'high',
        payinId,
        invoiceId: String(payin.invoiceId || invoice?._id || ''),
        expectedAmount: invoicePaymentAmount,
        actualAmount: roundMoney(completedTx.amount),
        message: 'Completed invoice payment amount does not match Payload payin amount.',
      });
    }

    if (invoice?.propertyId && !findMatchingLedgerPayment(ledgerEntries, {
      invoiceId: payin.invoiceId || invoice?._id,
      gatewayExternalId: payinId,
      amount: invoicePaymentAmount,
    })) {
      issues.push({
        code: RECONCILIATION_ISSUE.PAYIN_SETTLED_MISSING_LEDGER,
        severity: 'high',
        payinId,
        invoiceId: String(payin.invoiceId || invoice?._id || ''),
        propertyId: String(invoice.propertyId),
        message: 'Payload payin is succeeded but no matching ledger payment entry was found.',
      });
    }
  }

  if (payinStatus === PAYIN_STATUS.RETURNED && completedTx && !processingTx) {
    issues.push({
      code: RECONCILIATION_ISSUE.PAYIN_RETURNED_STILL_COMPLETED,
      severity: 'critical',
      payinId,
      invoiceId: String(payin.invoiceId || invoice?._id || ''),
      message: 'Payload payin was returned but invoice still shows a completed payment.',
    });
  }

  const staleAnchor = payin.lastWebhookAt || payin.updatedAt || payin.createdAt;
  if (payinStatus === PAYIN_STATUS.IN_REVIEW && hoursSince(staleAnchor, nowMs) >= staleInReviewHours) {
    issues.push({
      code: RECONCILIATION_ISSUE.PAYIN_IN_REVIEW_STALE,
      severity: 'medium',
      payinId,
      invoiceId: String(payin.invoiceId || invoice?._id || ''),
      hoursOpen: Math.round(hoursSince(staleAnchor, nowMs)),
      message: 'Payload payin has remained in review longer than the stale threshold.',
    });
  }

  if (payinStatus === PAYIN_STATUS.PROCESSING && hoursSince(staleAnchor, nowMs) >= staleProcessingHours) {
    issues.push({
      code: RECONCILIATION_ISSUE.PAYIN_PROCESSING_STALE,
      severity: 'medium',
      payinId,
      invoiceId: String(payin.invoiceId || invoice?._id || ''),
      hoursOpen: Math.round(hoursSince(staleAnchor, nowMs)),
      message: 'Payload payin has remained processing longer than the stale threshold.',
    });
  }

  return issues;
}

function assessFailedWebhookEvent(eventDoc = {}) {
  if (String(eventDoc.processingStatus || '') !== WEBHOOK_PROCESSING_STATUS.FAILED) {
    return null;
  }

  return {
    code: RECONCILIATION_ISSUE.WEBHOOK_FAILED,
    severity: 'high',
    eventId: eventDoc.eventId || '',
    eventType: eventDoc.eventType || '',
    retryCount: Number(eventDoc.retryCount || 0),
    error: eventDoc.error || '',
    message: 'Payload webhook event failed processing and may need manual retry.',
  };
}

function summarizeReconciliationIssues(issues = []) {
  const byCode = {};
  for (const issue of issues) {
    const code = issue.code || 'unknown';
    byCode[code] = (byCode[code] || 0) + 1;
  }
  return {
    total: issues.length,
    byCode,
    hasCritical: issues.some((issue) => issue.severity === 'critical'),
    hasHigh: issues.some((issue) => issue.severity === 'high'),
  };
}

module.exports = {
  RECONCILIATION_ISSUE,
  roundMoney,
  findMatchingInvoicePaymentTx,
  findProcessingInvoicePaymentTx,
  findMatchingLedgerPayment,
  assessPayloadPayinRow,
  assessFailedWebhookEvent,
  summarizeReconciliationIssues,
};
