'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  compareCalendarDates,
  isPaymentDateOnOrAfterInvoiceGeneration,
  assertPaymentDateOnOrAfterInvoiceGeneration,
  PAYMENT_DATE_BEFORE_INVOICE_GENERATION,
} = require('./invoicePaymentDate.helper');

describe('invoicePaymentDate.helper', () => {
  const invoiceCreatedAt = new Date('2026-08-10T15:30:00.000Z');

  it('compareCalendarDates treats same calendar day as equal', () => {
    assert.equal(compareCalendarDates('2026-08-10', invoiceCreatedAt), 0);
    assert.equal(compareCalendarDates(new Date('2026-08-10T00:00:00.000Z'), invoiceCreatedAt), 0);
  });

  it('compareCalendarDates treats earlier calendar day as before', () => {
    assert.equal(compareCalendarDates('2026-08-05', invoiceCreatedAt), -1);
  });

  it('compareCalendarDates treats later calendar day as after', () => {
    assert.equal(compareCalendarDates('2026-08-15', invoiceCreatedAt), 1);
  });

  it('isPaymentDateOnOrAfterInvoiceGeneration allows equal and later dates', () => {
    assert.equal(isPaymentDateOnOrAfterInvoiceGeneration('2026-08-10', invoiceCreatedAt), true);
    assert.equal(isPaymentDateOnOrAfterInvoiceGeneration('2026-08-22', invoiceCreatedAt), true);
  });

  it('isPaymentDateOnOrAfterInvoiceGeneration rejects earlier dates', () => {
    assert.equal(isPaymentDateOnOrAfterInvoiceGeneration('2026-08-05', invoiceCreatedAt), false);
  });

  it('assertPaymentDateOnOrAfterInvoiceGeneration throws for earlier dates', () => {
    assert.throws(
      () => assertPaymentDateOnOrAfterInvoiceGeneration('2026-08-05', invoiceCreatedAt),
      (err) => err.message === PAYMENT_DATE_BEFORE_INVOICE_GENERATION && err.status === 400
    );
  });

  it('assertPaymentDateOnOrAfterInvoiceGeneration passes for valid dates', () => {
    assert.doesNotThrow(() => assertPaymentDateOnOrAfterInvoiceGeneration('2026-08-10', invoiceCreatedAt));
    assert.doesNotThrow(() => assertPaymentDateOnOrAfterInvoiceGeneration('2026-08-22', invoiceCreatedAt));
  });
});
