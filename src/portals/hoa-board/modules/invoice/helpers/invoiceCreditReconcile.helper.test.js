const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  previewCreditReconcileOnReduction,
  computeBalanceAfterAmountEdit,
} = require('./invoiceCreditReconcile.helper');
const {
  sumCreditAppliedOnInvoice,
  getPaymentTransactionNetTowardInvoice,
} = require('./invoicePaymentTransactions.helper');

describe('invoiceCreditReconcile.helper', () => {
  it('nets credit returns against applied credit on an invoice', () => {
    const invoice = {
      paymentTransactions: [
        { method: 'Credit Adjustment', amount: 100 },
        { method: 'Credit Returned', amount: 50 },
      ],
    };

    assert.equal(sumCreditAppliedOnInvoice(invoice), 50);
    assert.equal(getPaymentTransactionNetTowardInvoice({ method: 'Credit Returned', amount: 50 }), -50);
    assert.equal(
      sumCreditAppliedOnInvoice({
        paymentTransactions: [
          { method: 'Credit Adjustment', amount: 100 },
          { method: 'Credit Balance', amount: 10, note: 'Overpayment of $10.00 stored as credit balance' },
        ],
      }),
      100
    );
  });

  it('returns $50 credit to the owner when a fully credited $100 invoice is reduced to $50', () => {
    const preview = previewCreditReconcileOnReduction({
      totalPaid: 100,
      creditApplied: 100,
      oldSub: 100,
      newSub: 50,
    });

    assert.deepEqual(preview, {
      oldSub: 100,
      newSub: 50,
      newAlreadyPaid: 50,
      returnToPool: 50,
      creditReturnPortion: 50,
      newCreditApplied: 50,
      newBalanceDue: 0,
    });
  });

  it('returns only the excess when partial credit was applied', () => {
    const preview = previewCreditReconcileOnReduction({
      totalPaid: 25,
      creditApplied: 25,
      oldSub: 100,
      newSub: 10,
    });

    assert.equal(preview.returnToPool, 15);
    assert.equal(preview.newCreditApplied, 10);
    assert.equal(preview.newBalanceDue, 0);
  });

  it('returns mixed overpayment to credit when cash and credit were both used', () => {
    const preview = previewCreditReconcileOnReduction({
      totalPaid: 100,
      creditApplied: 25,
      oldSub: 100,
      newSub: 50,
    });

    assert.equal(preview.returnToPool, 50);
    assert.equal(preview.creditReturnPortion, 25);
    assert.equal(preview.newCreditApplied, 0);
    assert.equal(preview.newBalanceDue, 0);
  });

  it('does not return credit when the reduced amount still covers all payments', () => {
    const preview = previewCreditReconcileOnReduction({
      totalPaid: 25,
      creditApplied: 25,
      oldSub: 100,
      newSub: 50,
    });

    assert.equal(preview.returnToPool, 0);
    assert.equal(preview.newAlreadyPaid, 25);
    assert.equal(preview.newBalanceDue, 25);
  });

  it('keeps processing cash applied when invoice amount increases after electronic pay', () => {
    assert.equal(
      computeBalanceAfterAmountEdit({
        subAmount: 120,
        alreadyPaid: 0,
        processingAmount: 100,
        waivedAmount: 0,
      }),
      20
    );
    assert.equal(
      computeBalanceAfterAmountEdit({
        subAmount: 120,
        alreadyPaid: 100,
        processingAmount: 0,
        waivedAmount: 0,
      }),
      20
    );
  });

  it('subtracts processing from remaining when reducing above the paid floor', () => {
    const preview = previewCreditReconcileOnReduction({
      totalPaid: 0,
      creditApplied: 0,
      oldSub: 150,
      newSub: 120,
      processingAmount: 100,
      waivedAmount: 0,
    });

    assert.equal(preview.newBalanceDue, 20);
  });
});
