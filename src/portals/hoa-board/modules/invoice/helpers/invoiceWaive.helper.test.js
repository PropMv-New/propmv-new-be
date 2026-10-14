const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const {
  applyInvoiceWaiveReversal,
  applyNonPaymentWaiveBalanceGuard,
  computeCollectableBalance,
  getActiveWaivedLineItemIndices,
  syncInvoiceBalanceWithActiveWaive,
} = require('./invoiceWaive.helper');

describe('invoiceWaive.helper', () => {
  it('restores a fully waived invoice to outstanding and records reversal history', () => {
    const reversedAt = new Date('2026-08-21T12:00:00.000Z');
    const invoice = {
      status: INVOICE_STATUS.WAIVED,
      subAmount: 1000,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 0,
      waivedAmount: 200,
      waivedBy: 'board-1',
      waivedAt: new Date('2026-08-20T12:00:00.000Z'),
      waiveReason: 'Courtesy waiver',
      dueDate: new Date('2026-09-01T16:00:00.000Z'),
      waiveHistory: [{
        amount: 200,
        reason: 'Courtesy waiver',
        lineItemIndex: 0,
        invoiceItem: 'HOA Fee',
        waivedBy: 'board-1',
        waivedAt: new Date('2026-08-20T12:00:00.000Z'),
      }],
    };

    const result = applyInvoiceWaiveReversal(invoice, { userId: 'board-2', now: reversedAt });

    assert.equal(result.reverseAmount, 200);
    assert.equal(invoice.balanceDue, 200);
    assert.equal(invoice.waivedAmount, 0);
    assert.equal(invoice.waivedBy, null);
    assert.equal(invoice.waiveReason, '');
    assert.notEqual(invoice.status, INVOICE_STATUS.WAIVED);
    assert.ok(
      invoice.status === INVOICE_STATUS.PENDING || invoice.status === INVOICE_STATUS.OVERDUE
    );
    assert.equal(invoice.waiveHistory[0].reversed, true);
    assert.equal(invoice.waiveHistory[0].reversedBy, 'board-2');
    assert.equal(invoice.waiveReversalHistory.length, 1);
    assert.equal(invoice.waiveReversalHistory[0].amount, 200);
    assert.equal(invoice.waiveReversalHistory[0].previousStatus, INVOICE_STATUS.WAIVED);
    assert.equal(invoice.waiveReversalHistory[0].newStatus, invoice.status);
    assert.equal(getActiveWaivedLineItemIndices(invoice).size, 0);
  });

  it('restores a partial waiver onto a partially paid invoice', () => {
    const invoice = {
      status: INVOICE_STATUS.PARTIALLY_PAID,
      subAmount: 1000,
      alreadyPaid: 600,
      processingAmount: 0,
      balanceDue: 200,
      waivedAmount: 200,
      dueDate: new Date('2026-08-01T16:00:00.000Z'),
      waiveHistory: [{
        amount: 200,
        lineItemIndex: 1,
        reversed: false,
      }],
    };

    applyInvoiceWaiveReversal(invoice, { userId: 'board-2', now: new Date('2026-08-21T12:00:00.000Z') });

    assert.equal(invoice.balanceDue, 400);
    assert.equal(invoice.waivedAmount, 0);
    assert.equal(invoice.status, INVOICE_STATUS.PARTIALLY_PAID);
  });

  it('does not inflate remaining beyond unpaid principal when reversing after remaining was restored', () => {
    const invoice = {
      status: INVOICE_STATUS.PENDING,
      subAmount: 100,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 90,
      waivedAmount: 100,
      dueDate: new Date('2026-08-01T16:00:00.000Z'),
      waiveHistory: [{ amount: 100, lineItemIndex: 0, reversed: false }],
    };

    applyInvoiceWaiveReversal(invoice, { userId: 'board-2', now: new Date('2026-08-21T12:00:00.000Z') });

    assert.equal(invoice.balanceDue, 100);
    assert.equal(invoice.waivedAmount, 0);
  });

  it('caps reverse-waive so property remaining cannot jump to $190 after a bad reopen', () => {
    // A was reopened with stale remaining $90 while still carrying a $100 waiver;
    // stacking waiver onto remaining would yield $190. Unpaid principal is $100.
    const invoiceA = {
      status: INVOICE_STATUS.PENDING,
      subAmount: 100,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 90,
      waivedAmount: 100,
      dueDate: new Date('2026-08-01T16:00:00.000Z'),
      waiveHistory: [{ amount: 100, lineItemIndex: 0, reversed: false }],
    };
    const invoiceBRemaining = 100;

    applyInvoiceWaiveReversal(invoiceA, { userId: 'board-2', now: new Date('2026-08-21T12:00:00.000Z') });

    assert.equal(invoiceA.balanceDue, 100);
    assert.equal(invoiceA.balanceDue + invoiceBRemaining, 200);
    assert.notEqual(invoiceA.balanceDue + invoiceBRemaining, 190);
  });

  it('does not stack waived amount on remaining after credit was wrongly applied', () => {
    const invoice = {
      status: INVOICE_STATUS.PARTIALLY_PAID,
      subAmount: 100,
      alreadyPaid: 50,
      processingAmount: 0,
      balanceDue: 50,
      waivedAmount: 100,
      dueDate: new Date('2026-08-01T16:00:00.000Z'),
      waiveHistory: [{ amount: 100, lineItemIndex: 0, reversed: false }],
    };

    applyInvoiceWaiveReversal(invoice, { userId: 'board-2', now: new Date('2026-08-21T12:00:00.000Z') });

    assert.equal(invoice.balanceDue, 50);
    assert.equal(invoice.waivedAmount, 0);
    assert.equal(invoice.status, INVOICE_STATUS.PARTIALLY_PAID);
  });

  it('ignores client remaining that would reopen a waived invoice on a description-only save', () => {
    const invoice = {
      status: INVOICE_STATUS.WAIVED,
      subAmount: 100,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 0,
      waivedAmount: 100,
    };
    const updates = {
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 100,
    };

    applyNonPaymentWaiveBalanceGuard(invoice, updates, { hasPaymentIntent: false });

    assert.equal(updates.balanceDue, 0);
    assert.equal(computeCollectableBalance({ ...invoice, balanceDue: 100 }), 0);
  });

  it('re-syncs a waived invoice document after Object.assign so auto-credit sees zero collectable', () => {
    const invoice = {
      status: INVOICE_STATUS.PENDING,
      subAmount: 100,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 100,
      waivedAmount: 100,
      dueDate: new Date('2026-08-01T16:00:00.000Z'),
      waiveHistory: [{ amount: 100, lineItemIndex: 0, reversed: false }],
    };

    syncInvoiceBalanceWithActiveWaive(invoice, { hasPaymentIntent: false });

    assert.equal(invoice.balanceDue, 0);
    assert.equal(invoice.status, INVOICE_STATUS.WAIVED);
    assert.equal(computeCollectableBalance(invoice), 0);
  });

  it('guards using active waiveHistory when waivedAmount scalar was cleared', () => {
    const invoice = {
      status: INVOICE_STATUS.WAIVED,
      subAmount: 100,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 0,
      waivedAmount: 0,
      waiveHistory: [{ amount: 100, lineItemIndex: 0, reversed: false }],
    };
    const updates = { balanceDue: 100, alreadyPaid: 0, subAmount: 100 };

    applyNonPaymentWaiveBalanceGuard(invoice, updates, { hasPaymentIntent: false });

    assert.equal(updates.balanceDue, 0);
    assert.equal(updates.waivedAmount, 100);
  });

  it('keeps collectable remaining on a partial waive', () => {
    assert.equal(computeCollectableBalance({
      subAmount: 200,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 100,
      waivedAmount: 100,
    }), 100);
  });

  it('does not rewrite remaining when a payment is being recorded', () => {
    const invoice = {
      status: INVOICE_STATUS.PENDING,
      subAmount: 200,
      alreadyPaid: 0,
      processingAmount: 0,
      balanceDue: 100,
      waivedAmount: 100,
    };
    const updates = { alreadyPaid: 50, balanceDue: 50 };

    applyNonPaymentWaiveBalanceGuard(invoice, updates, { hasPaymentIntent: true });

    assert.equal(updates.balanceDue, 50);
  });

  it('rejects reversing an invoice with no waived amount', () => {
    assert.throws(
      () => applyInvoiceWaiveReversal({ status: INVOICE_STATUS.PENDING, waivedAmount: 0, balanceDue: 100 }),
      (err) => err.status === 400 && /no waived amount/i.test(err.message)
    );
  });
});
