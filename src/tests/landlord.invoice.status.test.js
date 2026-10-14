const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveLandlordInvoiceStatus,
  getDaysPastDue,
  isDueToday,
  isOverdueLandlordInvoice,
  startOfDay,
} = require('../common/helpers/landlordInvoiceStatus.helper');
const { INVOICE_STATUS } = require('../common/constants/invoice');

const ref = new Date('2026-06-28T12:00:00.000Z');

test('deriveLandlordInvoiceStatus marks unpaid past-due invoices as Overdue', () => {
  const status = deriveLandlordInvoiceStatus({
    subAmount: 1000,
    balanceDue: 1000,
    dueDate: new Date('2026-06-01T12:00:00.000Z'),
  }, ref);
  assert.equal(status, INVOICE_STATUS.OVERDUE);
});

test('deriveLandlordInvoiceStatus marks fully paid invoices as Paid', () => {
  const status = deriveLandlordInvoiceStatus({
    subAmount: 1000,
    balanceDue: 0,
    dueDate: new Date('2026-06-01T12:00:00.000Z'),
  }, ref);
  assert.equal(status, INVOICE_STATUS.PAID);
});

test('deriveLandlordInvoiceStatus marks partial past-due invoices as Overdue', () => {
  const status = deriveLandlordInvoiceStatus({
    subAmount: 1000,
    balanceDue: 400,
    dueDate: new Date('2026-06-01T12:00:00.000Z'),
  }, ref);
  assert.equal(status, INVOICE_STATUS.OVERDUE);
});

test('deriveLandlordInvoiceStatus marks partial current invoices as Partially Paid', () => {
  const status = deriveLandlordInvoiceStatus({
    subAmount: 1000,
    balanceDue: 400,
    dueDate: new Date('2026-06-28T12:00:00.000Z'),
  }, ref);
  assert.equal(status, INVOICE_STATUS.PARTIALLY_PAID);
});

test('isDueToday returns true only for invoices due on the reference day', () => {
  assert.equal(isDueToday(new Date('2026-06-28T12:00:00.000Z'), ref), true);
  assert.equal(isDueToday(new Date('2026-06-27T12:00:00.000Z'), ref), false);
  assert.equal(isDueToday(new Date('2026-06-29T12:00:00.000Z'), ref), false);
});

test('isOverdueLandlordInvoice requires open balance and past due date', () => {
  assert.equal(isOverdueLandlordInvoice({
    balanceDue: 100,
    dueDate: new Date('2026-06-01T12:00:00.000Z'),
  }, ref), true);
  assert.equal(isOverdueLandlordInvoice({
    balanceDue: 0,
    dueDate: new Date('2026-06-01T12:00:00.000Z'),
  }, ref), false);
});

test('getDaysPastDue counts whole days after due date', () => {
  assert.equal(getDaysPastDue(new Date('2026-06-28T12:00:00.000Z'), ref), 0);
  assert.equal(getDaysPastDue(new Date('2026-06-27T12:00:00.000Z'), ref), 1);
});

test('startOfDay returns noon UTC anchor for the business calendar day', () => {
  const normalized = startOfDay(new Date('2026-06-28T18:30:00.000Z'));
  assert.equal(normalized.toISOString(), '2026-06-28T12:00:00.000Z');
});
