const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const {
  computeCollectionStatsFromInvoices,
  resolveInvoiceProcessingAmount,
} = require('../services/ledger.service');

describe('ledger collection stats', () => {
  const now = new Date('2026-08-28T16:00:00.000Z');

  it('sums processingAmount for Processing invoices instead of partial alreadyPaid', () => {
    const invoices = [
      {
        status: INVOICE_STATUS.PROCESSING,
        dueDate: new Date('2026-08-01T00:00:00.000Z'),
        subAmount: 1000,
        alreadyPaid: 0,
        balanceDue: 600,
        processingAmount: 400,
        paymentTransactions: [],
      },
      {
        status: INVOICE_STATUS.PARTIALLY_PAID,
        dueDate: new Date('2026-08-15T00:00:00.000Z'),
        subAmount: 500,
        alreadyPaid: 200,
        balanceDue: 300,
        processingAmount: 0,
        paymentTransactions: [],
      },
    ];

    const stats = computeCollectionStatsFromInvoices(invoices, now);

    assert.equal(stats.processing, 400);
    assert.equal(stats.collected, 200);
  });

  it('includes processing on future-due invoices', () => {
    const invoices = [
      {
        status: INVOICE_STATUS.PROCESSING,
        dueDate: new Date('2026-09-05T00:00:00.000Z'),
        subAmount: 750,
        alreadyPaid: 0,
        balanceDue: 350,
        processingAmount: 400,
        paymentTransactions: [],
      },
    ];

    const stats = computeCollectionStatsFromInvoices(invoices, now);

    assert.equal(stats.processing, 400);
    assert.equal(stats.comingDue, 350);
  });

  it('falls back to processing payment transactions when processingAmount is missing', () => {
    const invoice = {
      status: INVOICE_STATUS.PROCESSING,
      dueDate: new Date('2026-08-10T00:00:00.000Z'),
      subAmount: 500,
      alreadyPaid: 0,
      balanceDue: 300,
      processingAmount: 0,
      paymentTransactions: [
        { amount: 200, status: 'processing', method: 'ACH' },
      ],
    };

    assert.equal(resolveInvoiceProcessingAmount(invoice), 200);
  });
});
