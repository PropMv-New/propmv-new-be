/**
 * Compose Income / HOA board KPI amounts from the invoice summary aggregation row.
 *
 * Processing invoices split across:
 * - Processing card → cash still in flight (`processingAmount`)
 * - Overdue / Due Today / Coming Due → remaining `balanceDue` by due calendar
 *
 * Partially Paid card uses settled cash (`partiallyPaidCollected`) only —
 * electronic / in-flight processing dollars are not double-counted there.
 *
 * Matches `computeLandlordSummaryFromInvoices` bucket rules.
 */
function composeHoaBoardSummaryFromAggRow(summaryRow) {
  if (!summaryRow) return null;

  const partiallyPaidCollected = summaryRow.partiallyPaidCollected || 0;
  const collectedAmount = (summaryRow.collectedAmount || 0)
    + (summaryRow.partiallyPaidCollected || 0);
  const processingPastDueOverdue = summaryRow.processingPastDueOverdue || 0;
  const processingDueToday = summaryRow.processingDueToday || 0;
  const processingComingDue = summaryRow.processingComingDue || 0;

  const overdueAmount = (summaryRow.overdueAmount || 0)
    + (summaryRow.partiallyPaidOverdue || 0)
    + processingPastDueOverdue;
  const dueTodayAmount = (summaryRow.pendingTodayAmount || 0)
    + (summaryRow.partiallyPaidDueToday || 0)
    + processingDueToday;
  const comingDueAmount = (summaryRow.pendingFutureAmount || 0)
    + (summaryRow.partiallyPaidComingDue || 0)
    + processingComingDue;
  // Remaining open balances only. Processing cash is a separate KPI and is not
  // additional amount owed (matches computeLandlordSummaryFromInvoices).
  const outstandingAmount = overdueAmount + dueTodayAmount + comingDueAmount;

  const totalInvoiceAmount = summaryRow.totalInvoiceAmount || 0;
  const collectionRate = totalInvoiceAmount > 0
    ? Math.round((collectedAmount / totalInvoiceAmount) * 100)
    : 0;

  return {
    collectedAmount,
    outstandingAmount,
    comingDueAmount,
    dueTodayAmount,
    overdueAmount,
    partiallyPaidAmount: partiallyPaidCollected,
    processingAmount: summaryRow.processingAmount || 0,
    totalInvoiceAmount,
    waivedAmount: summaryRow.waivedAmount || 0,
    collectionRate,
  };
}

/**
 * Map hoaBoardSummary + statusCounts into owner/board listing KPI card shape.
 * Mirrors frontend `statsFromApiFallback` in ownerInvoiceSummary.ts.
 */
function mapAggregateToSummaryStats(hoaBoardSummary, statusCounts) {
  const summary = hoaBoardSummary || {};
  const counts = statusCounts || {};
  const dueTodayAmount = summary.dueTodayAmount || 0;
  const upcomingAmount = summary.comingDueAmount || 0;
  const overdueAmount = summary.overdueAmount || 0;

  return {
    totalInvoices: counts.totalInvoices || 0,
    totalPaidAmount: summary.collectedAmount || 0,
    pendingAmount: summary.outstandingAmount != null
      ? summary.outstandingAmount
      : (overdueAmount + dueTodayAmount + upcomingAmount),
    overdueAmount,
    dueTodayAmount,
    upcomingAmount,
    creditBalance: 0,
    overdueCount: counts.overdue || 0,
    pastOverdueAmount: summary.pastOverdueAmount || 0,
    pastOverdueCount: summary.pastOverdueCount || 0,
    paidCount: counts.collected || 0,
    partialPaidCount: counts.partiallyPaid || 0,
    partialPaidAmount: summary.partiallyPaidAmount || 0,
    processingCount: counts.processing || 0,
    processingAmount: summary.processingAmount || 0,
    openCount: (counts.overdue || 0) + (counts.due || 0),
    waivedAmount: summary.waivedAmount || 0,
  };
}

module.exports = {
  composeHoaBoardSummaryFromAggRow,
  mapAggregateToSummaryStats,
};
