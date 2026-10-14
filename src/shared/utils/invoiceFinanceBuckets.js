/**
 * ------------------------------------------------------------------
 * File: invoiceFinanceBuckets.js
 * Module: Src Shared Utils
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoiceFinanceBuckets.
 *
 * Used By:
 * dashboard.service, invoice.service, landlordFinanceSummary.util
 * ------------------------------------------------------------------
 */

const { INVOICE_STATUS } = require('../../common/constants/invoice');

/**
 * normalize Invoice Status
 *
 * Performs logic operations for normalizeInvoiceStatus.
 *
 * @param invoice - Request/input argument
 * @returns Operations result
 */
function normalizeInvoiceStatus(invoice) {
  return String(invoice?.status || '').trim().toLowerCase();
}

/**
 * Categorize invoice amounts by persisted status so dashboard finance stats
 * match the income listing when the same status filters are applied.
 */
function categorizeInvoiceAmounts(invoice) {
  const summary = {
    collectedAmount: 0,
    processingAmount: 0,
    overdueAmount: 0,
    comingDueAmount: 0,
  };

  if (!invoice) return summary;

  const status = normalizeInvoiceStatus(invoice);
  const subAmount = Number(invoice.subAmount || 0);

  const paidStatus = String(INVOICE_STATUS.PAID).toLowerCase();
  const pendingStatus = String(INVOICE_STATUS.PENDING).toLowerCase();
  const overdueStatus = String(INVOICE_STATUS.OVERDUE).toLowerCase();
  const partiallyPaidStatus = String(INVOICE_STATUS.PARTIALLY_PAID).toLowerCase();

  if (status === paidStatus || status === partiallyPaidStatus) {
    summary.collectedAmount += subAmount;
  } else if (status === overdueStatus) {
    summary.overdueAmount += subAmount;
  } else if (status === pendingStatus) {
    summary.comingDueAmount += subAmount;
  } else {
    summary.processingAmount += subAmount;
  }

  return summary;
}

/**
 * aggregate Finance Summary
 *
 * Performs logic operations for aggregateFinanceSummary.
 *
 * @param invoices - Request/input argument
 * @returns Operations result
 */
function aggregateFinanceSummary(invoices) {
  const summary = {
    collectedAmount: 0,
    processingAmount: 0,
    overdueAmount: 0,
    comingDueAmount: 0,
    totalAmount: 0,
    collectionRate: 0,
    outstandingAmount: 0,
  };

  (invoices || []).forEach((inv) => {
    const buckets = categorizeInvoiceAmounts(inv);
    summary.collectedAmount += buckets.collectedAmount;
    summary.processingAmount += buckets.processingAmount;
    summary.overdueAmount += buckets.overdueAmount;
    summary.comingDueAmount += buckets.comingDueAmount;
  });

  summary.totalAmount =
    summary.collectedAmount +
    summary.processingAmount +
    summary.overdueAmount +
    summary.comingDueAmount;
  summary.outstandingAmount =
    summary.processingAmount + summary.overdueAmount + summary.comingDueAmount;
  summary.collectionRate =
    summary.totalAmount > 0
      ? Math.round((summary.collectedAmount / summary.totalAmount) * 100)
      : 0;

  return summary;
}

const DASHBOARD_BUCKET_KEYS = new Set(['total', 'collected', 'overdue', 'coming_due', 'processing']);

/**
 * invoice Matches Dashboard Bucket
 *
 * Performs logic operations for invoiceMatchesDashboardBucket.
 *
 * @param invoice - Request/input argument
 * @param bucket - Request/input argument
 * @returns Operations result
 */
function invoiceMatchesDashboardBucket(invoice, bucket) {
  if (!bucket || bucket === 'total') return true;

  const status = normalizeInvoiceStatus(invoice);
  const paidStatus = String(INVOICE_STATUS.PAID).toLowerCase();
  const pendingStatus = String(INVOICE_STATUS.PENDING).toLowerCase();
  const overdueStatus = String(INVOICE_STATUS.OVERDUE).toLowerCase();
  const partiallyPaidStatus = String(INVOICE_STATUS.PARTIALLY_PAID).toLowerCase();

  if (bucket === 'collected') {
    return status === paidStatus || status === partiallyPaidStatus;
  }
  if (bucket === 'overdue') return status === overdueStatus;
  if (bucket === 'coming_due') return status === pendingStatus;
  if (bucket === 'processing') return categorizeInvoiceAmounts(invoice).processingAmount > 0;
  return true;
}

/** Map dashboard widget keys to invoice status values for indexed DB filtering. */
function resolveDashboardBucketStatusFilter(bucket) {
  const normalized = String(bucket || '').trim().toLowerCase();
  if (!normalized || normalized === 'total') return null;

  if (normalized === 'collected') {
    return { $in: [INVOICE_STATUS.PAID, INVOICE_STATUS.PARTIALLY_PAID] };
  }
  if (normalized === 'overdue') return INVOICE_STATUS.OVERDUE;
  if (normalized === 'coming_due') return INVOICE_STATUS.PENDING;
  return null;
}

/**
 * normalize Dashboard Bucket
 *
 * Performs logic operations for normalizeDashboardBucket.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function normalizeDashboardBucket(value) {
  const bucket = String(value || '').trim().toLowerCase();
  return DASHBOARD_BUCKET_KEYS.has(bucket) ? bucket : null;
}

module.exports = {
  categorizeInvoiceAmounts,
  aggregateFinanceSummary,
  invoiceMatchesDashboardBucket,
  normalizeDashboardBucket,
  resolveDashboardBucketStatusFilter,
};
