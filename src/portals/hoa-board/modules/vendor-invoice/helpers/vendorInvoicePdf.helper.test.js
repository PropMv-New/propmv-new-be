'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildVendorInvoicePdfBuffer,
  buildVendorInvoicePdfLines,
  vendorInvoiceAttachmentFileName,
} = require('./vendorInvoicePdf.helper');

describe('vendorInvoicePdf.helper', () => {
  const sampleInvoice = {
    _id: '6ac9f1c682c46ea973a77d9e',
    invoiceNumber: 'VI-42',
    title: 'Plumbing repair',
    status: 'Paid',
    subAmount: 100,
    amountPaid: 100,
    balanceDue: 0,
    lineItems: [
      { description: 'Labor', quantity: 2, rate: 40, amount: 80 },
      { description: 'Parts', quantity: 1, rate: 20, amount: 20 },
    ],
  };

  it('builds readable summary lines including partial-friendly totals', () => {
    const lines = buildVendorInvoicePdfLines({
      ...sampleInvoice,
      amountPaid: 40,
      balanceDue: 60,
      status: 'Pending',
    });
    assert.ok(lines.some((l) => /Invoice #: VI-42/.test(l)));
    assert.ok(lines.some((l) => /Amount paid: \$40\.00/.test(l)));
    assert.ok(lines.some((l) => /Balance due: \$60\.00/.test(l)));
    assert.ok(lines.some((l) => /Labor/.test(l)));
  });

  it('returns a PDF buffer with header and EOF markers', () => {
    const buf = buildVendorInvoicePdfBuffer(sampleInvoice);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 100);
    assert.equal(buf.subarray(0, 5).toString('utf8'), '%PDF-');
    assert.match(buf.toString('utf8'), /%%EOF/);
    assert.match(buf.toString('utf8'), /VI-42/);
  });

  it('sanitizes attachment file names', () => {
    assert.equal(
      vendorInvoiceAttachmentFileName({ invoiceNumber: 'VI/42 draft' }),
      'VendorInvoice-VI-42-draft.pdf'
    );
  });
});
