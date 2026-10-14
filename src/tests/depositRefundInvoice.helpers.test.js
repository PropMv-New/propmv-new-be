const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getCurrentMonthRange,
  resolveTenantDepositPortionFromSplit,
  resolveTenantDepositRefunds,
  buildDepositRefundLineItems,
} = require('../portals/landlord/modules/invoice/service/depositRefundInvoice.helpers');
const { INVOICE_TYPES } = require('../common/constants/invoice');

const leaseSplit = {
  rentAndDepositDestribution: {
    split: [
      { tenantId: 't1', depositAmount: 500, depositPercentage: 50 },
      { tenantId: 't2', depositAmount: 500, depositPercentage: 50 },
    ],
  },
};

test('getCurrentMonthRange returns start of month through start of next month', () => {
  const ref = new Date('2026-06-15T12:00:00.000Z');
  const { start, end } = getCurrentMonthRange(ref);
  assert.equal(start.getDate(), 1);
  assert.equal(start.getMonth(), 5);
  assert.equal(end.getMonth(), 6);
  assert.equal(end.getDate(), 1);
});

test('resolveTenantDepositPortionFromSplit uses explicit depositAmount', () => {
  const entry = { depositAmount: 500 };
  const amount = resolveTenantDepositPortionFromSplit(entry, [entry], 1000, 1000);
  assert.equal(amount, 500);
});

test('resolveTenantDepositRefunds uses paymentHistory per tenant', () => {
  const depositInvoice = {
    type: INVOICE_TYPES.DEPOSIT,
    subAmount: 1000,
    alreadyPaid: 1000,
    paymentHistory: [
      { userId: 't1', paymentAmount: 500 },
      { userId: 't2', paymentAmount: 500 },
    ],
  };

  const refunds = resolveTenantDepositRefunds(depositInvoice, leaseSplit, {
    t1: 'Alice',
    t2: 'Bob',
  });

  assert.equal(refunds.length, 2);
  assert.equal(refunds[0].amount, 500);
  assert.equal(refunds[1].amount, 500);
  assert.equal(refunds[0].tenantName, 'Alice');
});

test('resolveTenantDepositRefunds falls back to split when no payment history', () => {
  const depositInvoice = {
    type: INVOICE_TYPES.DEPOSIT,
    subAmount: 1000,
    alreadyPaid: 1000,
    paymentHistory: [],
  };

  const refunds = resolveTenantDepositRefunds(depositInvoice, leaseSplit, {
    t1: 'Alice',
    t2: 'Bob',
  });

  assert.equal(refunds.length, 2);
  assert.equal(refunds[0].amount, 500);
  assert.equal(refunds[1].amount, 500);
});

test('buildDepositRefundLineItems creates one line item per tenant', () => {
  const tenantRefunds = [
    { tenantId: 't1', tenantName: 'Alice', amount: 500 },
    { tenantId: 't2', tenantName: 'Bob', amount: 500 },
  ];

  const items = buildDepositRefundLineItems(tenantRefunds, new Date('2026-06-30T00:00:00.000Z'));
  assert.equal(items.length, 2);
  assert.match(items[0].invoiceItem, /Alice/);
  assert.match(items[1].invoiceItem, /Bob/);
  assert.equal(items[0].amount, 500);
  assert.equal(items[1].amount, 500);
});
