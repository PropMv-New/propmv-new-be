'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const { VENDOR_INVOICE_STATUS } = require('../model/vendorInvoice.model');

function loadHelperWithInvoiceStub(makeInvoice) {
  const helperPath = require.resolve('./vendorInvoiceGatewayPayment.helper');
  const modelPath = require.resolve('../model/vendorInvoice.model');
  delete require.cache[helperPath];

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === modelPath || request.endsWith('vendorInvoice.model')) {
      return {
        VENDOR_INVOICE_STATUS,
        findOne: async () => makeInvoice(),
      };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require('./vendorInvoiceGatewayPayment.helper');
  } finally {
    Module._load = originalLoad;
  }
}

const INVOICE_OID = '6ac9f1c682c46ea973a77d9e';

function makeMutableInvoice(overrides = {}) {
  const doc = {
    _id: INVOICE_OID,
    subAmount: 100,
    amountPaid: 0,
    balanceDue: 100,
    status: VENDOR_INVOICE_STATUS.PENDING,
    paidAt: undefined,
    activityTimeline: [{ kind: 'created', at: new Date() }],
    isDeleted: false,
    save: async function save() { return this; },
    toObject() { return { ...this }; },
    ...overrides,
  };
  return doc;
}

describe('vendorInvoiceGatewayPayment.helper (mocked)', () => {
  it('marks Processing with status_change and does not set paidAt', async () => {
    const inv = makeMutableInvoice();
    const helper = loadHelperWithInvoiceStub(() => inv);
    const result = await helper.markVendorInvoiceElectronicProcessing({
      vendorInvoiceId: INVOICE_OID,
      recordedBy: 'payer-1',
      note: 'Electronic payment pending',
    });
    assert.equal(result.status, VENDOR_INVOICE_STATUS.PROCESSING);
    assert.equal(result.paidAt, undefined);
    assert.ok(result.activityTimeline.some(
      (e) => e.kind === 'status_change' && e.newStatus === VENDOR_INVOICE_STATUS.PROCESSING,
    ));
  });

  it('settlement sets paidAt, amountPaid, and payment timeline entry', async () => {
    const inv = makeMutableInvoice({ status: VENDOR_INVOICE_STATUS.PROCESSING });
    const helper = loadHelperWithInvoiceStub(() => inv);
    // Prevent expense / email side-effect require from failing the test
    const expensePath = require.resolve('./vendorInvoiceExpense.helper');
    require.cache[expensePath] = {
      id: expensePath,
      filename: expensePath,
      loaded: true,
      exports: { ensureExpenseForPaidVendorInvoice: async () => null },
    };
    const paymentEmailPath = require.resolve('./vendorInvoicePaymentEmail.helper');
    require.cache[paymentEmailPath] = {
      id: paymentEmailPath,
      filename: paymentEmailPath,
      loaded: true,
      exports: { notifyVendorInvoicePaymentEmailInBackground: () => {} },
    };
    const settled = await helper.settleVendorInvoiceGatewayPayment({
      vendorInvoiceId: INVOICE_OID,
      paymentAmount: 100,
      methodLabel: 'card',
      recordedBy: 'system',
      paidBy: 'payer-1',
      payinId: 'txn_test_1',
    });
    assert.equal(settled.status, VENDOR_INVOICE_STATUS.PAID);
    assert.equal(settled.amountPaid, 100);
    assert.equal(settled.balanceDue, 0);
    assert.ok(settled.paidAt);
    assert.ok(settled.activityTimeline.some(
      (e) => e.kind === 'payment'
        && e.amount === 100
        && String(e.note || '') === 'Electronic card payment'
        && !String(e.note || '').includes('txn_'),
    ));
  });

  it('failed payment does not mark Paid or set paidAt', async () => {
    const inv = makeMutableInvoice({ status: VENDOR_INVOICE_STATUS.PROCESSING });
    const helper = loadHelperWithInvoiceStub(() => inv);
    const failed = await helper.failVendorInvoiceGatewayPayment({
      vendorInvoiceId: INVOICE_OID,
      hasOtherInFlight: false,
      note: 'Card declined',
    });
    assert.notEqual(failed.status, VENDOR_INVOICE_STATUS.PAID);
    assert.equal(failed.amountPaid, 0);
    assert.ok(!failed.paidAt);
  });

  it('reversal clears paidAt and restores balance', async () => {
    const inv = makeMutableInvoice({
      status: VENDOR_INVOICE_STATUS.PAID,
      amountPaid: 100,
      balanceDue: 0,
      paidAt: new Date(),
    });
    const helper = loadHelperWithInvoiceStub(() => inv);
    const reversed = await helper.reverseVendorInvoiceGatewayPayment({
      vendorInvoiceId: INVOICE_OID,
      paymentAmount: 100,
      payinId: 'txn_rev_1',
    });
    assert.equal(reversed.amountPaid, 0);
    assert.equal(reversed.balanceDue, 100);
    assert.equal(reversed.status, VENDOR_INVOICE_STATUS.PENDING);
    assert.equal(reversed.paidAt, null);
  });

  it('partial settlement clears Processing and preserves amountPaid/balanceDue', async () => {
    const inv = makeMutableInvoice({ status: VENDOR_INVOICE_STATUS.PROCESSING });
    const helper = loadHelperWithInvoiceStub(() => inv);
    const expensePath = require.resolve('./vendorInvoiceExpense.helper');
    require.cache[expensePath] = {
      id: expensePath,
      filename: expensePath,
      loaded: true,
      exports: { ensureExpenseForPaidVendorInvoice: async () => null },
    };
    const paymentEmailCalls = [];
    const paymentEmailPath = require.resolve('./vendorInvoicePaymentEmail.helper');
    require.cache[paymentEmailPath] = {
      id: paymentEmailPath,
      filename: paymentEmailPath,
      loaded: true,
      exports: {
        notifyVendorInvoicePaymentEmailInBackground: (payload) => {
          paymentEmailCalls.push(payload);
        },
      },
    };
    const partial = await helper.settleVendorInvoiceGatewayPayment({
      vendorInvoiceId: INVOICE_OID,
      paymentAmount: 40,
      methodLabel: 'card',
      payinId: 'txn_partial',
    });
    assert.equal(partial.amountPaid, 40);
    assert.equal(partial.balanceDue, 60);
    // Settlement exits Processing; payin service re-marks Processing only if another payin is in flight.
    assert.equal(partial.status, VENDOR_INVOICE_STATUS.PENDING);
    assert.ok(!partial.paidAt);
    const payment = partial.activityTimeline.find((e) => e.kind === 'payment');
    assert.ok(payment);
    assert.equal(payment.note, 'Electronic card payment');
    assert.ok(!String(payment.note).includes('txn_'));
    assert.equal(paymentEmailCalls.length, 1);
    assert.equal(paymentEmailCalls[0].paymentAmount, 40);
    assert.equal(paymentEmailCalls[0].balanceAfter, 60);
  });
});
