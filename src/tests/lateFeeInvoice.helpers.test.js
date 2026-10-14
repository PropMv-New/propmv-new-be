const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLateFeeType,
  calculateLateFeeAmount,
  calculateExpectedLateFeeCount,
  buildLateFeeLineItems,
  generateLateFeeTitle,
  resolveLateFeeRuleId,
  isEligibleForLateFee,
  isUnitApplicable,
} = require('../portals/landlord/modules/invoice/service/lateFeeInvoice.helpers');
const { INVOICE_TYPES } = require('../common/constants/invoice');

const leaseEqual = {
  rentAndDepositDestribution: {
    isAllTenantsEquallyResponsible: true,
    split: [
      { tenantId: 't1', rentPercentage: 50 },
      { tenantId: 't2', rentPercentage: 50 },
    ],
  },
};

const leaseIndividual = {
  rentAndDepositDestribution: {
    isAllTenantsEquallyResponsible: false,
    split: [
      { tenantId: 't1', rentPercentage: 60 },
      { tenantId: 't2', rentPercentage: 40 },
    ],
  },
};

const rentInvoice = {
  type: INVOICE_TYPES.RENT,
  invoiceId: 'INV100001',
  subAmount: 1000,
  balanceDue: 1000,
  dueDate: new Date('2026-06-01T00:00:00.000Z'),
  unit: 'Unit 1',
  tenants: ['t1', 't2'],
};

const ref = new Date('2026-06-28T00:00:00.000Z');

test('normalizeLateFeeType maps UI and legacy values', () => {
  assert.equal(normalizeLateFeeType('flat-fee'), 'flat-fee');
  assert.equal(normalizeLateFeeType('Fixed'), 'flat-fee');
  assert.equal(normalizeLateFeeType('percentage-total'), 'percentage-total');
  assert.equal(normalizeLateFeeType('percentage-outstanding'), 'percentage-outstanding');
});

test('calculateLateFeeAmount supports flat, percentage total, and percentage outstanding', () => {
  assert.equal(
    calculateLateFeeAmount(rentInvoice, { lateFeeType: 'flat-fee', feeAmount: 25 }, leaseEqual),
    25
  );
  assert.equal(
    calculateLateFeeAmount(rentInvoice, { lateFeeType: 'percentage-total', feeAmount: 10 }, leaseEqual),
    100
  );
  assert.equal(
    calculateLateFeeAmount(rentInvoice, { lateFeeType: 'percentage-outstanding', feeAmount: 5 }, leaseEqual),
    50
  );
});

test('calculateLateFeeAmount multiplies by unpaid tenants when chargeEachUnpaidTenat is enabled', () => {
  const amount = calculateLateFeeAmount(
    rentInvoice,
    { lateFeeType: 'flat-fee', feeAmount: 20, chargeEachUnpaidTenat: true },
    leaseEqual
  );
  assert.equal(amount, 40);
});

test('buildLateFeeLineItems splits amounts per tenant when responsibility is individual', () => {
  const items = buildLateFeeLineItems(
    'Late Fee INV100001 - 1',
    'Late fee',
    100,
    leaseIndividual,
    { t1: 'Alice', t2: 'Bob' }
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].amount, 60);
  assert.equal(items[1].amount, 40);
});

test('calculateExpectedLateFeeCount handles one-time and recurring late fees', () => {
  const oneTime = calculateExpectedLateFeeCount(
    rentInvoice,
    { isRepeat: false, gracePeriod: 3 },
    ref
  );
  assert.equal(oneTime, 1);

  const recurring = calculateExpectedLateFeeCount(
    rentInvoice,
    { isRepeat: true, gracePeriod: 0, repeatEvery: 7, repeatEndAfter: 3 },
    ref
  );
  assert.equal(recurring, 3);
});

test('generateLateFeeTitle uses parent invoice number and occurrence count', () => {
  assert.equal(generateLateFeeTitle(rentInvoice, 2), 'Late Fee INV100001 - 2');
});

test('resolveLateFeeRuleId is stable per configured rule', () => {
  const idA = resolveLateFeeRuleId({ lateFeeType: 'flat-fee', feeAmount: 20, gracePeriod: 3 }, 0);
  const idB = resolveLateFeeRuleId({ lateFeeType: 'flat-fee', feeAmount: 20, gracePeriod: 3 }, 0);
  const idC = resolveLateFeeRuleId({ lateFeeType: 'flat-fee', feeAmount: 25, gracePeriod: 3 }, 1);
  assert.equal(idA, idB);
  assert.notEqual(idA, idC);
});

test('isEligibleForLateFee requires rent invoice with balance past grace period', () => {
  assert.equal(isEligibleForLateFee(rentInvoice, 5, ref), true);
  assert.equal(isEligibleForLateFee({ ...rentInvoice, balanceDue: 0 }, 0, ref), false);
  assert.equal(isEligibleForLateFee({ ...rentInvoice, type: INVOICE_TYPES.OTHER }, 0, ref), false);
});

test('isUnitApplicable respects specific unit scope', () => {
  const rule = { applicableScope: 'specific', applicableUnits: ['Unit 1'] };
  assert.equal(isUnitApplicable(rule, 'Unit 1'), true);
  assert.equal(isUnitApplicable(rule, 'Unit 2'), false);
});
