const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getInvoiceCollectableBalance,
  removeStaleDuplicateGatewayProcessingRows,
  recalculateInvoiceTotalsFromTransactions,
} = require('./invoicePaymentTransactions.helper');

describe('partial gateway payments', () => {
  it('uses scalar fields when payment rows are empty but alreadyPaid is set', () => {
    const invoice = {
      subAmount: 100,
      alreadyPaid: 50,
      processingAmount: 0,
      waivedAmount: 0,
      balanceDue: 0,
      paymentTransactions: [],
    };
    assert.equal(getInvoiceCollectableBalance(invoice), 50);
  });

  it('collectable balance stays positive after partial card settle', () => {
    const invoice = {
      subAmount: 100,
      waivedAmount: 0,
      paymentTransactions: [
        {
          amount: 50,
          status: 'completed',
          isManual: false,
          gatewayTransactionId: 'payinLocal1',
          gatewayExternalId: 'txn_abc',
        },
      ],
    };
    assert.equal(getInvoiceCollectableBalance(invoice), 50);
  });

  it('does not treat a fully waived invoice as collectable when balanceDue is stale', () => {
    const invoice = {
      subAmount: 100,
      alreadyPaid: 0,
      processingAmount: 0,
      waivedAmount: 100,
      balanceDue: 100,
      paymentTransactions: [],
    };
    assert.equal(getInvoiceCollectableBalance(invoice), 0);
  });

  it('removes stale processing row when completed gateway payment exists', () => {
    const invoice = {
      subAmount: 100,
      waivedAmount: 0,
      balanceDue: 0,
      alreadyPaid: 50,
      processingAmount: 50,
      paymentTransactions: [
        {
          amount: 50,
          status: 'completed',
          isManual: false,
          gatewayTransactionId: 'payinLocal1',
          gatewayExternalId: 'txn_abc',
        },
        {
          amount: 50,
          status: 'processing',
          isManual: false,
          gatewayTransactionId: 'payinLocal1',
          gatewayExternalId: 'txn_abc',
        },
      ],
    };
    removeStaleDuplicateGatewayProcessingRows(invoice);
    const totals = recalculateInvoiceTotalsFromTransactions(invoice);
    assert.equal(totals.processingAmount, 0);
    assert.equal(totals.alreadyPaid, 50);
    assert.equal(totals.balanceDue, 50);
    assert.equal(getInvoiceCollectableBalance(invoice), 50);
  });
});
