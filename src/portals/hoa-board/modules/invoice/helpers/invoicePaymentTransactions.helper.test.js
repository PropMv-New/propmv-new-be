const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  sumCreditAppliedOnInvoice,
  recalculateInvoiceTotalsFromTransactions,
  classifyPaymentTransaction,
  isElectronicPaymentTransaction,
} = require('./invoicePaymentTransactions.helper');

describe('invoicePaymentTransactions.helper', () => {
  it('identifies current and legacy electronic payment records', () => {
    assert.equal(isElectronicPaymentTransaction({ isManual: false, method: 'unknown' }), true);
    assert.equal(isElectronicPaymentTransaction({ method: 'card' }), true);
    assert.equal(
      isElectronicPaymentTransaction({ method: 'Other', note: 'Stripe card payment - pi_123' }),
      true
    );
    assert.equal(isElectronicPaymentTransaction({ isManual: true, method: 'Cash' }), false);
    assert.equal(isElectronicPaymentTransaction({ method: 'Check' }), false);
    assert.equal(isElectronicPaymentTransaction({ method: 'check21' }), true);
    assert.equal(
      isElectronicPaymentTransaction({ isManual: false, method: 'check' }),
      true,
    );
  });

  it('does not count overpayment credit storage as applied credit', () => {
    const invoice = {
      subAmount: 200,
      alreadyPaid: 200,
      paymentTransactions: [
        { method: 'Cash', amount: 200, note: 'amount received' },
        {
          method: 'Credit Balance',
          amount: 10,
          note: 'Overpayment of $10.00 stored as credit balance',
        },
      ],
    };

    assert.equal(sumCreditAppliedOnInvoice(invoice), 0);
    assert.equal(classifyPaymentTransaction(invoice.paymentTransactions[1]), 'credit_stored');

    const totals = recalculateInvoiceTotalsFromTransactions(invoice);
    assert.deepEqual(totals, { alreadyPaid: 200, processingAmount: 0, balanceDue: 0 });
  });

  it('nets credit returns against applied credit', () => {
    const invoice = {
      subAmount: 50,
      paymentTransactions: [
        { method: 'Credit Adjustment', amount: 100 },
        { method: 'Credit Returned', amount: 50 },
      ],
    };

    assert.equal(sumCreditAppliedOnInvoice(invoice), 50);
    const totals = recalculateInvoiceTotalsFromTransactions({
      ...invoice,
      waivedAmount: 0,
    });
    assert.equal(totals.alreadyPaid, 50);
    assert.equal(totals.processingAmount, 0);
    assert.equal(totals.balanceDue, 0);
  });

  it('ignores soft-deleted payment transactions for credit and invoice totals', () => {
    const invoice = {
      subAmount: 500,
      waivedAmount: 0,
      paymentTransactions: [
        { method: 'Credit Adjustment', amount: 500, isDeleted: true },
      ],
    };

    assert.equal(sumCreditAppliedOnInvoice(invoice), 0);
    const totals = recalculateInvoiceTotalsFromTransactions(invoice);
    assert.deepEqual(totals, { alreadyPaid: 0, processingAmount: 0, balanceDue: 500 });
  });

  it('tracks processing payments separately from paid and balance due', () => {
    const invoice = {
      subAmount: 1000,
      waivedAmount: 0,
      paymentTransactions: [
        {
          method: 'ACH',
          amount: 400,
          status: 'processing',
          isManual: false,
          balanceAfter: 600,
        },
      ],
    };

    const totals = recalculateInvoiceTotalsFromTransactions(invoice);
    assert.deepEqual(totals, { alreadyPaid: 0, processingAmount: 400, balanceDue: 600 });
  });
});
