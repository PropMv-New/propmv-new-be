const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  composeHoaBoardSummaryFromAggRow,
  mapAggregateToSummaryStats,
} = require('./invoiceSummaryBuckets.helper');

describe('composeHoaBoardSummaryFromAggRow', () => {
  it('returns null for a missing summary row', () => {
    assert.equal(composeHoaBoardSummaryFromAggRow(null), null);
  });

  it('adds processing remaining balance to Coming Due (not only pending invoices)', () => {
    const summary = composeHoaBoardSummaryFromAggRow({
      totalInvoiceAmount: 500,
      waivedAmount: 0,
      collectedAmount: 0,
      processingAmount: 60,
      partiallyPaidCollected: 0,
      partiallyPaidOverdue: 0,
      partiallyPaidDueToday: 0,
      partiallyPaidComingDue: 0,
      processingPastDueOverdue: 0,
      processingDueToday: 0,
      processingComingDue: 40,
      overdueAmount: 0,
      pendingFutureAmount: 400,
      pendingTodayAmount: 0,
      pendingOutstanding: 400,
    });

    assert.equal(summary.processingAmount, 60);
    assert.equal(summary.comingDueAmount, 440);
    assert.equal(summary.dueTodayAmount, 0);
    assert.equal(summary.overdueAmount, 0);
    assert.equal(summary.outstandingAmount, 440);
  });

  it('keeps overdue, outstanding, and processing aligned after a full pay plus an electronic partial', () => {
    const summary = composeHoaBoardSummaryFromAggRow({
      totalInvoiceAmount: 200,
      waivedAmount: 0,
      collectedAmount: 100,
      processingAmount: 30,
      partiallyPaidCollected: 0,
      processingPartialCollected: 30,
      partiallyPaidOverdue: 0,
      partiallyPaidDueToday: 0,
      partiallyPaidComingDue: 0,
      processingPastDueOverdue: 70,
      processingDueToday: 0,
      processingComingDue: 0,
      overdueAmount: 0,
      pendingFutureAmount: 0,
      pendingTodayAmount: 0,
      pendingOutstanding: 0,
    });

    assert.equal(summary.overdueAmount, 70);
    assert.equal(summary.outstandingAmount, 70);
    // Electronic / Processing dollars stay on Processing — not Partially Paid.
    assert.equal(summary.partiallyPaidAmount, 0);
    assert.equal(summary.collectedAmount, 100);
    assert.equal(summary.processingAmount, 30);
  });

  it('counts settled cash partials on Partially Paid without adding processing dollars', () => {
    const summary = composeHoaBoardSummaryFromAggRow({
      totalInvoiceAmount: 200,
      waivedAmount: 0,
      collectedAmount: 100,
      processingAmount: 0,
      partiallyPaidCollected: 40,
      processingPartialCollected: 0,
      partiallyPaidOverdue: 60,
      partiallyPaidDueToday: 0,
      partiallyPaidComingDue: 0,
      processingPastDueOverdue: 0,
      processingDueToday: 0,
      processingComingDue: 0,
      overdueAmount: 0,
      pendingFutureAmount: 0,
      pendingTodayAmount: 0,
      pendingOutstanding: 0,
    });

    assert.equal(summary.partiallyPaidAmount, 40);
    assert.equal(summary.overdueAmount, 60);
    assert.equal(summary.processingAmount, 0);
  });

  it('adds processing remaining balance to Due Today and Overdue by due calendar', () => {
    const summary = composeHoaBoardSummaryFromAggRow({
      totalInvoiceAmount: 300,
      waivedAmount: 0,
      collectedAmount: 0,
      processingAmount: 50,
      partiallyPaidCollected: 0,
      partiallyPaidOverdue: 0,
      partiallyPaidDueToday: 0,
      partiallyPaidComingDue: 0,
      processingPastDueOverdue: 80,
      processingDueToday: 20,
      processingComingDue: 0,
      overdueAmount: 100,
      pendingFutureAmount: 0,
      pendingTodayAmount: 50,
      pendingOutstanding: 50,
    });

    assert.equal(summary.processingAmount, 50);
    assert.equal(summary.overdueAmount, 180);
    assert.equal(summary.dueTodayAmount, 70);
    assert.equal(summary.comingDueAmount, 0);
  });
});

describe('mapAggregateToSummaryStats', () => {
  it('maps hoaBoardSummary + statusCounts like frontend statsFromApiFallback', () => {
    const stats = mapAggregateToSummaryStats(
      {
        collectedAmount: 500,
        outstandingAmount: 250,
        comingDueAmount: 100,
        dueTodayAmount: 50,
        overdueAmount: 100,
        pastOverdueAmount: 0,
        pastOverdueCount: 0,
        partiallyPaidAmount: 40,
        processingAmount: 30,
      },
      {
        totalInvoices: 12,
        collected: 5,
        comingDue: 2,
        due: 1,
        overdue: 3,
        partiallyPaid: 1,
        processing: 1,
      }
    );

    assert.equal(stats.totalInvoices, 12);
    assert.equal(stats.totalPaidAmount, 500);
    assert.equal(stats.pendingAmount, 250);
    assert.equal(stats.upcomingAmount, 100);
    assert.equal(stats.dueTodayAmount, 50);
    assert.equal(stats.overdueAmount, 100);
    assert.equal(stats.partialPaidAmount, 40);
    assert.equal(stats.processingAmount, 30);
    assert.equal(stats.paidCount, 5);
    assert.equal(stats.partialPaidCount, 1);
    assert.equal(stats.processingCount, 1);
    assert.equal(stats.overdueCount, 3);
    assert.equal(stats.openCount, 4);
    assert.equal(stats.creditBalance, 0);
    assert.equal(stats.waivedAmount, 0);
  });

  it('maps waivedAmount from hoaBoardSummary', () => {
    const stats = mapAggregateToSummaryStats(
      {
        collectedAmount: 100,
        outstandingAmount: 0,
        comingDueAmount: 0,
        dueTodayAmount: 0,
        overdueAmount: 0,
        partiallyPaidAmount: 0,
        processingAmount: 0,
        waivedAmount: 75,
      },
      { totalInvoices: 2 }
    );
    assert.equal(stats.waivedAmount, 75);
  });
});
