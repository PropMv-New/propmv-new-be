const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateLandlordInvoicePayment,
  resolveTenantPaymentLimits,
  resolveTenantPortionFromLineItems,
} = require('../common/helpers/landlordInvoicePayment.helper');

const leaseEqual = {
  rentAndDepositDestribution: {
    isAllTenantsEquallyResponsible: true,
    isPartialPaymentAllowed: true,
    split: [
      { tenantId: 'tenant-a', rentPercentage: 50 },
      { tenantId: 'tenant-b', rentPercentage: 50 },
    ],
  },
};

const leaseIndividual = {
  rentAndDepositDestribution: {
    isAllTenantsEquallyResponsible: false,
    isPartialPaymentAllowed: true,
    split: [
      { tenantId: 'tenant-a', rentPercentage: 60 },
      { tenantId: 'tenant-b', rentPercentage: 40 },
    ],
  },
};

const invoice = {
  subAmount: 1000,
  balanceDue: 1000,
  isPartialPaymentAllowed: true,
  invoiceItemDetails: [
    { invoiceItem: 'Rent - Alice', description: 'Rent - Alice', amount: 600 },
    { invoiceItem: 'Rent - Bob', description: 'Rent - Bob', amount: 400 },
  ],
  paymentHistory: [],
};

test('resolveTenantPortionFromLineItems matches tenant-specific line items', () => {
  assert.equal(resolveTenantPortionFromLineItems(invoice, 'Alice'), 600);
  assert.equal(resolveTenantPortionFromLineItems(invoice, 'Bob'), 400);
});

test('resolveTenantPaymentLimits returns full balance when tenants are equally responsible', () => {
  const limits = resolveTenantPaymentLimits(invoice, leaseEqual, 'tenant-a', { 'tenant-a': 'Alice' });
  assert.equal(limits.equallyResponsible, true);
  assert.equal(limits.maxPaymentBeforeOverpayment, 1000);
});

test('resolveTenantPaymentLimits caps individual tenant to their assigned portion', () => {
  const limits = resolveTenantPaymentLimits(invoice, leaseIndividual, 'tenant-a', { 'tenant-a': 'Alice' });
  assert.equal(limits.equallyResponsible, false);
  assert.equal(limits.tenantRemainingPortion, 600);
  assert.equal(limits.maxPaymentBeforeOverpayment, 600);
});

test('validateLandlordInvoicePayment rejects partial payment when not allowed', () => {
  const result = validateLandlordInvoicePayment(
    { ...invoice, isPartialPaymentAllowed: false },
    leaseEqual,
    500,
    'tenant-a'
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /Partial payments are not allowed/i);
});

test('validateLandlordInvoicePayment rejects paying beyond tenant portion without full payoff', () => {
  const result = validateLandlordInvoicePayment(
    invoice,
    leaseIndividual,
    700,
    'tenant-a',
    { 'tenant-a': 'Alice' }
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /only responsible for their portion/i);
});

test('validateLandlordInvoicePayment allows full invoice payoff from one tenant', () => {
  const result = validateLandlordInvoicePayment(
    invoice,
    leaseIndividual,
    1000,
    'tenant-a',
    { 'tenant-a': 'Alice' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.isInvoiceOverpayment, false);
});

test('validateLandlordInvoicePayment allows invoice-level overpayment', () => {
  const result = validateLandlordInvoicePayment(
    invoice,
    leaseIndividual,
    1500,
    'tenant-a',
    { 'tenant-a': 'Alice' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.isInvoiceOverpayment, true);
});

test('validateTenantPayment subtracts prior tenant payments from remaining portion', () => {
  const paidInvoice = {
    ...invoice,
    balanceDue: 400,
    alreadyPaid: 600,
    paymentHistory: [{ userId: 'tenant-a', paymentAmount: 600 }],
  };
  const limits = resolveTenantPaymentLimits(
    paidInvoice,
    leaseIndividual,
    'tenant-a',
    { 'tenant-a': 'Alice' }
  );
  assert.equal(limits.tenantRemainingPortion, 0);
  assert.equal(limits.maxPaymentBeforeOverpayment, 0);
});
