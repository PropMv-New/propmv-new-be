'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  notifyInvoicePaymentRemovalEffects,
} = require('./invoicePaymentRemovalNotify.helper');

function makeDeps() {
  const calls = {
    paymentDeletedEmail: [],
    paymentDeletedInApp: [],
    invoiceUpdated: [],
  };
  return {
    calls,
    deps: {
      notifyPaymentDeletedInBackground: (payload) => {
        calls.paymentDeletedEmail.push(payload);
      },
      notifyPaymentDeletedInAppInBackground: (...args) => {
        calls.paymentDeletedInApp.push(args);
      },
      notifyInvoiceUpdatedInBackground: (payload) => {
        calls.invoiceUpdated.push(payload);
      },
    },
  };
}

describe('notifyInvoicePaymentRemovalEffects', () => {
  it('sends a single payment-deleted notice for a simple single-invoice removal', () => {
    const { calls, deps } = makeDeps();
    const invoice = { _id: 'inv-b', invoiceId: 'INV-B' };
    const tx = { amount: 100, method: 'Check', paidAt: new Date('2026-08-13T12:00:00Z') };

    const result = notifyInvoicePaymentRemovalEffects(
      {
        invoice,
        userId: 'board-1',
        paymentTransactionId: 'tx-1',
        tx,
        removedPayment: {
          totalRemoved: 100,
          removedTransactions: [{
            invoiceId: 'inv-b',
            amount: 100,
            method: 'Check',
            kind: 'payment',
            paidAt: tx.paidAt,
          }],
          affectedInvoices: [invoice],
        },
        removedTxKind: 'payment',
        removedCreditAmount: 100,
      },
      deps,
    );

    assert.equal(result.paymentDeletedNotices, 1);
    assert.equal(result.secondaryUpdateNotices, 0);
    assert.equal(calls.paymentDeletedEmail.length, 1);
    assert.equal(calls.paymentDeletedInApp.length, 1);
    assert.equal(calls.invoiceUpdated.length, 0);
    assert.equal(calls.paymentDeletedEmail[0].paymentAmount, 100);
    assert.equal(calls.paymentDeletedEmail[0].paymentTransactionId, 'tx-1');
    assert.equal(calls.paymentDeletedInApp[0][0], invoice);
    assert.equal(calls.paymentDeletedInApp[0][2], 100);
    assert.equal(calls.paymentDeletedInApp[0][3], 'tx-1');
  });

  it('does not send duplicate payment-deleted notices for FIFO cross-invoice reversals', () => {
    const { calls, deps } = makeDeps();
    const invoiceB = { _id: 'inv-b', invoiceId: 'INV-B' };
    const invoiceA = { _id: 'inv-a', invoiceId: 'INV-A' };
    const tx = { amount: 50, method: 'Check', paidAt: new Date('2026-08-13T12:00:00Z') };

    const result = notifyInvoicePaymentRemovalEffects(
      {
        invoice: invoiceB,
        userId: 'board-1',
        paymentTransactionId: 'tx-fifo-1',
        tx,
        removedPayment: {
          totalRemoved: 150,
          removedTransactions: [
            {
              invoiceId: 'inv-b',
              amount: 150,
              method: 'Check',
              kind: 'payment',
              paidAt: tx.paidAt,
            },
            {
              invoiceId: 'inv-a',
              amount: 100,
              method: 'Check',
              kind: 'payment',
              paidAt: tx.paidAt,
            },
          ],
          affectedInvoices: [invoiceB, invoiceA, invoiceA],
        },
        removedTxKind: 'payment',
        removedCreditAmount: 50,
      },
      deps,
    );

    assert.equal(result.paymentDeletedNotices, 1);
    assert.equal(result.secondaryUpdateNotices, 1);
    assert.equal(calls.paymentDeletedEmail.length, 1, 'one payment-deleted email');
    assert.equal(calls.paymentDeletedInApp.length, 1, 'one payment-deleted in-app');
    assert.equal(calls.paymentDeletedEmail[0].invoice, invoiceB);
    assert.equal(calls.paymentDeletedEmail[0].paymentAmount, 150);
    assert.equal(calls.paymentDeletedInApp[0][0], invoiceB);
    assert.equal(calls.invoiceUpdated.length, 1);
    assert.equal(calls.invoiceUpdated[0].invoice, invoiceA);
    assert.match(
      calls.invoiceUpdated[0].activityIntro,
      /payment allocation of \$100\.00 was reversed/i,
    );
  });

  it('uses invoice-updated (not payment-deleted) for downstream credit unapplies', () => {
    const { calls, deps } = makeDeps();
    const invoiceB = { _id: 'inv-b', invoiceId: 'INV-B' };
    const invoiceC = { _id: 'inv-c', invoiceId: 'INV-C' };
    const tx = { amount: 50, method: 'Credit Balance', paidAt: new Date('2026-08-13T12:00:00Z') };

    notifyInvoicePaymentRemovalEffects(
      {
        invoice: invoiceB,
        userId: 'board-1',
        paymentTransactionId: 'tx-credit-1',
        tx,
        removedPayment: {
          totalRemoved: 50,
          removedTransactions: [
            {
              invoiceId: 'inv-b',
              amount: 50,
              method: 'Credit Balance',
              kind: 'credit_stored',
              paidAt: tx.paidAt,
            },
            {
              invoiceId: 'inv-c',
              amount: 50,
              method: 'Credit Adjustment',
              kind: 'credit_applied',
              paidAt: tx.paidAt,
            },
          ],
          affectedInvoices: [invoiceB, invoiceC],
        },
        removedTxKind: 'credit_stored',
        removedCreditAmount: 50,
      },
      deps,
    );

    assert.equal(calls.paymentDeletedEmail.length, 1);
    assert.equal(calls.paymentDeletedInApp.length, 1);
    assert.equal(calls.invoiceUpdated.length, 1);
    assert.equal(calls.invoiceUpdated[0].invoice, invoiceC);
    assert.match(
      calls.invoiceUpdated[0].activityIntro,
      /credit of \$50\.00 applied to your invoice was removed/i,
    );
  });
});
