'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeVendorInvoiceFinanceRows,
  VENDOR_INVOICE_STATUS,
} = require('./vendorInvoice.service');

describe('summarizeVendorInvoiceFinanceRows', () => {
  it('moves partial payment dollars into Paid and keeps remainder outstanding', () => {
    const summary = summarizeVendorInvoiceFinanceRows([
      {
        _id: VENDOR_INVOICE_STATUS.PENDING,
        count: 1,
        amountPaid: 40,
        balanceDue: 60,
        partiallyPaidCount: 1,
      },
    ]);

    assert.equal(summary.amounts.paid, 40);
    assert.equal(summary.amounts.pending, 60);
    assert.equal(summary.amounts.processing, 0);
    assert.equal(summary.amounts.partiallyPaid, 40);
    assert.equal(summary.amounts.total, 100);
    assert.equal(summary.amounts.overdue, 0);
    assert.equal(summary.amounts.dueToday, 0);
    assert.equal(summary.amounts.comingDue, 0);
    assert.equal(summary.partiallyPaid, 1);
    assert.equal(summary.paid, 0);
    assert.equal(summary.pending, 1);
  });

  it('keeps electronic partials in Processing balance while counting cash as Paid', () => {
    const summary = summarizeVendorInvoiceFinanceRows([
      {
        _id: VENDOR_INVOICE_STATUS.PROCESSING,
        count: 1,
        amountPaid: 25,
        balanceDue: 75,
        partiallyPaidCount: 1,
      },
    ]);

    assert.equal(summary.amounts.paid, 25);
    assert.equal(summary.amounts.processing, 75);
    assert.equal(summary.amounts.pending, 0);
    assert.equal(summary.amounts.partiallyPaid, 25);
    assert.equal(summary.amounts.total, 100);
  });

  it('sums full Paid invoices via amountPaid without double-counting balance', () => {
    const summary = summarizeVendorInvoiceFinanceRows([
      {
        _id: VENDOR_INVOICE_STATUS.PAID,
        count: 2,
        amountPaid: 200,
        balanceDue: 0,
        partiallyPaidCount: 0,
      },
      {
        _id: VENDOR_INVOICE_STATUS.PENDING,
        count: 1,
        amountPaid: 0,
        balanceDue: 50,
        partiallyPaidCount: 0,
      },
    ]);

    assert.equal(summary.amounts.paid, 200);
    assert.equal(summary.amounts.pending, 50);
    assert.equal(summary.amounts.partiallyPaid, 0);
    assert.equal(summary.amounts.total, 250);
    assert.equal(summary.paid, 2);
    assert.equal(summary.pending, 1);
  });

  it('excludes Cancelled invoices from money totals', () => {
    const summary = summarizeVendorInvoiceFinanceRows([
      {
        _id: VENDOR_INVOICE_STATUS.CANCELLED,
        count: 1,
        amountPaid: 10,
        balanceDue: 90,
        partiallyPaidCount: 1,
      },
      {
        _id: VENDOR_INVOICE_STATUS.PAID,
        count: 1,
        amountPaid: 80,
        balanceDue: 0,
        partiallyPaidCount: 0,
      },
    ]);

    assert.equal(summary.amounts.paid, 80);
    assert.equal(summary.amounts.partiallyPaid, 0);
    assert.equal(summary.amounts.total, 80);
    assert.equal(summary.cancelled, 1);
    assert.equal(summary.total, 2);
  });
});
