const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateLandlordInvoiceNumber,
  isLandlordInvoiceNumber,
  INVOICE_NUMBER_PATTERN,
} = require('../portals/landlord/modules/invoice/helpers/invoiceId.helper');

test('generateLandlordInvoiceNumber starts with INV and uses UUID hex', () => {
  const id = generateLandlordInvoiceNumber();
  assert.match(id, INVOICE_NUMBER_PATTERN);
  assert.ok(id.startsWith('INV'));
  assert.equal(id.length, 35);
});

test('generateLandlordInvoiceNumber produces unique values', () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateLandlordInvoiceNumber()));
  assert.equal(ids.size, 50);
});

test('isLandlordInvoiceNumber accepts generated numbers', () => {
  const id = generateLandlordInvoiceNumber();
  assert.equal(isLandlordInvoiceNumber(id), true);
});

test('isLandlordInvoiceNumber rejects legacy short ids and mongo object ids', () => {
  assert.equal(isLandlordInvoiceNumber('INV244649'), false);
  assert.equal(isLandlordInvoiceNumber('6a147194a79823bfd3ce9f13'), false);
});
