const test = require('node:test');
const assert = require('node:assert/strict');
const { ClockService } = require('../../../../../common/date');
const { getDateKeyInTimeZone } = require('../../../../../common/helpers/hoaBillingDates');
const {
  getSkipAutoCreditUntilNextDay,
  isInvoiceAutoCreditPaused,
  markInvoiceSkipAutoCredit,
  clearInvoiceSkipAutoCredit,
} = require('./invoiceAutoCredit.helper');

test('isInvoiceAutoCreditPaused is true when skipAutoCreditApply is set', () => {
  assert.equal(isInvoiceAutoCreditPaused({ skipAutoCreditApply: true }), true);
});

test('isInvoiceAutoCreditPaused sticky flag ignores expired skipAutoCreditUntil', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  assert.equal(
    isInvoiceAutoCreditPaused({ skipAutoCreditApply: true, skipAutoCreditUntil: yesterday }),
    true
  );
});

test('isInvoiceAutoCreditPaused is true before skipAutoCreditUntil', () => {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const invoice = { skipAutoCreditUntil: tomorrow };
  assert.equal(isInvoiceAutoCreditPaused(invoice, new Date()), true);
});

test('isInvoiceAutoCreditPaused is false after skipAutoCreditUntil', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const invoice = { skipAutoCreditUntil: yesterday };
  assert.equal(isInvoiceAutoCreditPaused(invoice, new Date()), false);
});

test('isInvoiceAutoCreditPaused is false when field is unset', () => {
  assert.equal(isInvoiceAutoCreditPaused({}), false);
  assert.equal(isInvoiceAutoCreditPaused({ skipAutoCreditUntil: null }), false);
  assert.equal(isInvoiceAutoCreditPaused({ skipAutoCreditApply: false }), false);
});

test('markInvoiceSkipAutoCredit sets sticky flag and clears date pause', () => {
  const invoice = { skipAutoCreditUntil: new Date() };
  markInvoiceSkipAutoCredit(invoice);
  assert.equal(invoice.skipAutoCreditApply, true);
  assert.equal(invoice.skipAutoCreditUntil, undefined);
  assert.equal(isInvoiceAutoCreditPaused(invoice), true);
});

test('clearInvoiceSkipAutoCredit allows auto-apply again', () => {
  const invoice = { skipAutoCreditApply: true, skipAutoCreditUntil: new Date() };
  clearInvoiceSkipAutoCredit(invoice);
  assert.equal(invoice.skipAutoCreditApply, false);
  assert.equal(invoice.skipAutoCreditUntil, undefined);
  assert.equal(isInvoiceAutoCreditPaused(invoice), false);
});

test('getSkipAutoCreditUntilNextDay returns a future instant', () => {
  const skipUntil = getSkipAutoCreditUntilNextDay();
  assert.ok(skipUntil instanceof Date);
  assert.ok(skipUntil.getTime() > Date.now() - 1000);
});

test('getSkipAutoCreditUntilNextDay uses the next calendar day in the property timezone', () => {
  ClockService.setFixedTime('2026-09-14T04:00:00.000Z');
  try {
    const skipUntil = getSkipAutoCreditUntilNextDay('America/New_York');
    assert.ok(skipUntil instanceof Date);
    assert.equal(getDateKeyInTimeZone(skipUntil, 'America/New_York'), '2026-09-15');
  } finally {
    ClockService.reset();
  }
});
