const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Invoice = require('../model/invoice.model');
const invoiceService = require('./invoice.service');

describe('INV-SC-026 invoice payment source guard', () => {
  const originalFindOne = Invoice.findOne;

  afterEach(() => {
    Invoice.findOne = originalFindOne;
  });

  it('rejects deleting a payment through an invoice that only received its automatic allocation', async () => {
    const allocation = {
      _id: 'allocation-payment-id',
      amount: 100,
      method: 'Cash',
      isManual: true,
      isDeleted: false,
      paymentGroupId: 'group-550',
      recordedAgainstInvoiceNumber: 'INV-B',
      fifoAllocationRole: 'prior_allocation',
      note: 'Applied $100.00 from payment on invoice #INV-B (overdue invoice)',
    };
    Invoice.findOne = async () => ({
      _id: 'invoice-a-id',
      paymentTransactions: {
        id: (paymentId) => (
          paymentId === allocation._id ? allocation : null
        ),
      },
    });

    await assert.rejects(
      invoiceService.deleteInvoicePayment('invoice-a-id', allocation._id, 'user-id'),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /automatically allocated/);
        assert.match(error.message, /invoice INV-B/);
        assert.match(error.message, /Remove the original payment there/);
        return true;
      },
    );
  });
});
