const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Unit coverage for vendor-invoice → expense helper surface that does not need Mongo.
 * Full ensureExpenseForPaidVendorInvoice is integration-tested via service wiring.
 */

describe('vendorInvoiceExpense helper exports', () => {
  it('exports ensureExpenseForPaidVendorInvoice and category constant', () => {
    const helper = require('../helpers/vendorInvoiceExpense.helper');
    assert.equal(typeof helper.ensureExpenseForPaidVendorInvoice, 'function');
    assert.equal(helper.EXPENSE_CATEGORY, 'Vendor Invoice');
  });

  it('skips when invoice id is missing', async () => {
    const { ensureExpenseForPaidVendorInvoice } = require('../helpers/vendorInvoiceExpense.helper');
    const result = await ensureExpenseForPaidVendorInvoice({}, { actorId: null });
    assert.equal(result.skipped, true);
    assert.equal(result.created, false);
    assert.equal(result.expense, null);
  });
});

describe('vendor invoice update schema accepts payment metadata', () => {
  it('allows paymentMethod, paymentDate, and bankAccount on update', () => {
    const { updateVendorInvoiceSchema } = require('../validators/vendorInvoice.validator');
    const { error, value } = updateVendorInvoiceSchema.validate({
      status: 'Paid',
      amountPaid: 100,
      paymentMethod: 'Check',
      paymentDate: '2026-09-19',
      bankAccount: 'Operating - *1234',
    });
    assert.equal(error, undefined);
    assert.equal(value.paymentMethod, 'Check');
    assert.equal(value.bankAccount, 'Operating - *1234');
  });
});
