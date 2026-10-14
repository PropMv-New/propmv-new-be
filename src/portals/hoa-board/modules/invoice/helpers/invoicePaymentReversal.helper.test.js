const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  getInvoiceDeleteCreditDelta,
  isPriorAllocationTransaction,
  recalculateInvoiceStatus,
  summarizeSourcePaymentDeleteRestriction,
  buildInvoiceDeleteRestrictionError,
  INVOICE_DELETE_PAYMENT_ALLOCATED,
} = require('./invoicePaymentReversal.helper');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { ClockService } = require('../../../../../common/date');
const responseHelper = require('../../../../../common/helpers/responseHelper');
const responseFormatter = require('../../../../../middleware/responseFormatter');

describe('invoicePaymentReversal.helper', () => {
  afterEach(() => ClockService.reset());

  it('INV-SC-026 identifies automatic prior-invoice allocations by metadata and legacy note', () => {
    assert.equal(isPriorAllocationTransaction({
      fifoAllocationRole: 'prior_allocation',
    }), true);
    assert.equal(isPriorAllocationTransaction({
      note: 'Applied $100.00 from payment on invoice #INV-B (overdue invoice)',
    }), true);
    assert.equal(isPriorAllocationTransaction({
      fifoAllocationRole: 'self_allocation',
      note: 'Payment recorded for invoice #INV-B',
    }), false);
  });

  it('returns applied credit and removes stored overpayment credit without restoring cash payments again', () => {
    const result = getInvoiceDeleteCreditDelta({
      subAmount: 200,
      alreadyPaid: 200,
      paymentTransactions: [
        { method: 'Cash', amount: 200 },
        { method: 'Credit Balance', amount: 850, note: 'Overpayment of $850.00 stored as credit balance' },
      ],
    });

    assert.deepEqual(result, {
      creditApplied: 0,
      creditStored: 850,
      netDelta: -850,
    });
  });

  it('returns only credit that was actually applied to the deleted invoice', () => {
    const result = getInvoiceDeleteCreditDelta({
      subAmount: 350,
      alreadyPaid: 350,
      paymentTransactions: [
        { method: 'Credit Adjustment', amount: 350, note: 'Applied $350.00 from available credit balance' },
      ],
    });

    assert.deepEqual(result, {
      creditApplied: 350,
      creditStored: 0,
      netDelta: 350,
    });
  });

  it('nets credit returned during invoice amount reductions before delete', () => {
    const result = getInvoiceDeleteCreditDelta({
      subAmount: 50,
      alreadyPaid: 50,
      paymentTransactions: [
        { method: 'Credit Adjustment', amount: 100 },
        { method: 'Credit Returned', amount: 50 },
      ],
    });

    assert.deepEqual(result, {
      creditApplied: 50,
      creditStored: 0,
      netDelta: 50,
    });
  });

  it('clears paidOn when payment removal leaves the invoice unpaid', () => {
    ClockService.setFixedTime('2026-08-15T12:00:00.000Z');
    const invoice = {
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 100,
      processingAmount: 0,
      dueDate: new Date('2026-08-31T00:00:00.000Z'),
      paidOn: new Date('2026-08-17T10:24:00.000Z'),
      status: INVOICE_STATUS.PAID,
    };

    recalculateInvoiceStatus(invoice);

    assert.equal(invoice.status, INVOICE_STATUS.PENDING);
    assert.equal(invoice.paidOn, undefined);
  });

  it('keeps paidOn when the invoice remains fully paid', () => {
    const paidOn = new Date('2026-08-17T10:24:00.000Z');
    const invoice = {
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      processingAmount: 0,
      dueDate: new Date('2026-08-31T00:00:00.000Z'),
      paidOn,
      status: INVOICE_STATUS.PAID,
    };

    recalculateInvoiceStatus(invoice);

    assert.equal(invoice.status, INVOICE_STATUS.PAID);
    assert.equal(invoice.paidOn, paidOn);
  });

  it('keeps Waived when outstanding is cleared by a waiver rather than payment', () => {
    const invoice = {
      subAmount: 200,
      alreadyPaid: 0,
      balanceDue: 0,
      processingAmount: 0,
      waivedAmount: 200,
      dueDate: new Date('2026-08-31T00:00:00.000Z'),
      status: INVOICE_STATUS.WAIVED,
    };

    recalculateInvoiceStatus(invoice);

    assert.equal(invoice.status, INVOICE_STATUS.WAIVED);
  });

  it('marks Paid when Record Payment clears the remainder after a line item was waived', () => {
    const paidOn = new Date('2026-08-17T10:24:00.000Z');
    const invoice = {
      subAmount: 200,
      alreadyPaid: 100,
      balanceDue: 0,
      processingAmount: 0,
      waivedAmount: 100,
      dueDate: new Date('2026-08-31T00:00:00.000Z'),
      paidOn,
      status: INVOICE_STATUS.WAIVED,
    };

    recalculateInvoiceStatus(invoice);

    assert.equal(invoice.status, INVOICE_STATUS.PAID);
    assert.equal(invoice.paidOn, paidOn);
  });

  it('marks Paid for credit-settled invoices that also have a waived line item', () => {
    const invoice = {
      subAmount: 200,
      alreadyPaid: 150,
      balanceDue: 0,
      processingAmount: 0,
      waivedAmount: 50,
      dueDate: new Date('2026-08-31T00:00:00.000Z'),
      status: INVOICE_STATUS.PENDING,
    };

    recalculateInvoiceStatus(invoice);

    assert.equal(invoice.status, INVOICE_STATUS.PAID);
  });

  it('blocks deleting Invoice B while its $100 payment is still applied to Invoice A', () => {
    const invoiceAId = 'inv-a';
    const invoiceB = {
      _id: 'inv-b',
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      paymentTransactions: [{
        fifoAllocationRole: 'recorded_only',
        paymentGroupId: 'group-100',
        recordedPaymentTotal: 100,
        amount: 0,
        fifoRedirectedAllocations: [
          { invoiceId: invoiceAId, invoiceNumber: 'INV-A', amount: 100 },
        ],
      }],
    };
    const invoiceA = {
      _id: invoiceAId,
      invoiceId: 'INV-A',
      paymentTransactions: [{
        fifoAllocationRole: 'prior_allocation',
        paymentGroupId: 'group-100',
        recordedAgainstInvoiceId: 'inv-b',
        recordedAgainstInvoiceNumber: 'INV-B',
        amount: 100,
        note: 'Applied $100.00 from payment on invoice #INV-B (overdue invoice)',
      }],
    };

    const restriction = summarizeSourcePaymentDeleteRestriction(invoiceB, [invoiceA]);

    assert.deepEqual(restriction, {
      recordedPaymentTotal: 100,
      allocations: [{ invoiceId: invoiceAId, invoiceNumber: 'INV-A', amount: 100 }],
    });
  });

  it('lists every invoice that received a split allocation from Invoice B', () => {
    const invoiceB = {
      _id: 'inv-b',
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      paymentTransactions: [{
        fifoAllocationRole: 'recorded_only',
        paymentGroupId: 'group-500',
        recordedPaymentTotal: 500,
        amount: 0,
      }],
    };
    const others = [
      { _id: 'inv-a', invoiceId: 'INV-A', paymentTransactions: [{ fifoAllocationRole: 'prior_allocation', paymentGroupId: 'group-500', amount: 100 }] },
      { _id: 'inv-c', invoiceId: 'INV-C', paymentTransactions: [{ fifoAllocationRole: 'prior_allocation', paymentGroupId: 'group-500', amount: 100 }] },
      { _id: 'inv-d', invoiceId: 'INV-D', paymentTransactions: [{ fifoAllocationRole: 'prior_allocation', paymentGroupId: 'group-500', amount: 100 }] },
      { _id: 'inv-e', invoiceId: 'INV-E', paymentTransactions: [{ fifoAllocationRole: 'prior_allocation', paymentGroupId: 'group-500', amount: 200 }] },
    ];

    const restriction = summarizeSourcePaymentDeleteRestriction(invoiceB, others);

    assert.equal(restriction.recordedPaymentTotal, 500);
    assert.deepEqual(restriction.allocations, [
      { invoiceId: 'inv-a', invoiceNumber: 'INV-A', amount: 100 },
      { invoiceId: 'inv-c', invoiceNumber: 'INV-C', amount: 100 },
      { invoiceId: 'inv-d', invoiceNumber: 'INV-D', amount: 100 },
      { invoiceId: 'inv-e', invoiceNumber: 'INV-E', amount: 200 },
    ]);
  });

  it('allows delete after source-payment allocations have been removed', () => {
    const invoiceB = {
      _id: 'inv-b',
      invoiceId: 'INV-B',
      paymentTransactions: [{
        fifoAllocationRole: 'recorded_only',
        paymentGroupId: 'group-100',
        recordedPaymentTotal: 100,
        amount: 0,
        isDeleted: true,
      }],
    };
    const invoiceA = {
      _id: 'inv-a',
      invoiceId: 'INV-A',
      paymentTransactions: [{
        fifoAllocationRole: 'prior_allocation',
        paymentGroupId: 'group-100',
        amount: 100,
        isDeleted: true,
      }],
    };

    assert.equal(summarizeSourcePaymentDeleteRestriction(invoiceB, [invoiceA]), null);
  });

  it('falls back to stored redirect metadata when sibling allocations are not loaded', () => {
    const invoiceB = {
      _id: 'inv-b',
      invoiceId: 'INV-B',
      paymentTransactions: [{
        fifoAllocationRole: 'recorded_only',
        paymentGroupId: 'group-100',
        recordedPaymentTotal: 100,
        amount: 0,
        fifoRedirectedAllocations: [
          { invoiceId: 'inv-a', invoiceNumber: 'INV-A', amount: 100 },
        ],
      }],
    };

    const restriction = summarizeSourcePaymentDeleteRestriction(invoiceB, []);

    assert.deepEqual(restriction, {
      recordedPaymentTotal: 100,
      allocations: [{ invoiceId: 'inv-a', invoiceNumber: 'INV-A', amount: 100 }],
    });
  });

  it('does not block delete when the source payment only applied to this invoice', () => {
    const invoiceB = {
      _id: 'inv-b',
      invoiceId: 'INV-B',
      paymentTransactions: [{
        fifoAllocationRole: 'self_allocation',
        paymentGroupId: 'group-self',
        recordedPaymentTotal: 100,
        amount: 100,
      }],
    };

    assert.equal(summarizeSourcePaymentDeleteRestriction(invoiceB, []), null);
  });

  it('does not block delete when a recorded_only source has no live allocations', () => {
    const invoiceB = {
      _id: 'inv-b',
      invoiceId: 'INV-B',
      paymentTransactions: [{
        fifoAllocationRole: 'recorded_only',
        paymentGroupId: 'group-orphan',
        recordedPaymentTotal: 100,
        amount: 0,
      }],
    };

    assert.equal(summarizeSourcePaymentDeleteRestriction(invoiceB, []), null);
  });

  it('builds a structured 400 that stays readable after responseHelper + formatter', () => {
    const restriction = {
      recordedPaymentTotal: 100,
      allocations: [{ invoiceId: 'inv-a', invoiceNumber: 'INV-A', amount: 100 }],
    };
    const err = buildInvoiceDeleteRestrictionError(restriction);
    assert.equal(err.status, 400);
    assert.equal(err.code, INVOICE_DELETE_PAYMENT_ALLOCATED);

    let sent;
    const res = {
      req: { originalUrl: '/api/v1/hoa-board/invoices/inv-b' },
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        sent = payload;
        return this;
      },
      send() {
        return this;
      },
    };
    responseFormatter({}, res, () => {});
    responseHelper.error(res, err.message, err.status, {
      code: err.code,
      ...err.details,
    });

    assert.equal(res.statusCode, 400);
    assert.equal(sent.message, err.message);
    assert.equal(sent.statuscode, 400);
    assert.equal(sent.data.code, INVOICE_DELETE_PAYMENT_ALLOCATED);
    assert.equal(sent.data.recordedPaymentTotal, 100);
    assert.deepEqual(sent.data.allocations, restriction.allocations);
  });

  it('documents that the old { message, code, data } payload is nested by the formatter', () => {
    let sent;
    const res = {
      statusCode: 400,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        sent = payload;
        return this;
      },
      send() {
        return this;
      },
    };
    responseFormatter({}, res, () => {});
    res.json({
      message: 'Cannot delete invoice while a recorded payment is applied to other invoices',
      code: INVOICE_DELETE_PAYMENT_ALLOCATED,
      data: {
        recordedPaymentTotal: 100,
        allocations: [{ invoiceId: 'inv-a', invoiceNumber: 'INV-A', amount: 100 }],
      },
    });

    assert.equal(sent.message, 'Error');
    assert.equal(sent.data.code, INVOICE_DELETE_PAYMENT_ALLOCATED);
    assert.equal(sent.data.data.recordedPaymentTotal, 100);
  });
});
