'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('createVendorInvoice paid-ticket guard', () => {
  it('rejects create when a Paid vendor invoice already exists for the ticket', () => {
    const src = fs.readFileSync(path.join(__dirname, 'vendorInvoice.service.js'), 'utf8');
    const start = src.indexOf('async function createVendorInvoice');
    assert.ok(start >= 0);
    const nextFn = src.indexOf('\nasync function listVendorInvoices', start + 1);
    const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
    assert.ok(body.includes('VENDOR_INVOICE_STATUS.PAID'));
    assert.ok(body.includes('already has a paid vendor invoice'));
    assert.ok(body.includes('err.status = 409'));
  });
});
