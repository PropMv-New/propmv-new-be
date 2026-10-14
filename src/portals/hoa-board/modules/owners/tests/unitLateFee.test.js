const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const {
  ensureLateFeeInvoicesForUnit,
  calculateLateFeeAmount,
  calculateHoaLateFeeAmount,
  getMaxSequenceForRule,
  getHoaMaxLateFeeSequence,
  getPrincipalOutstanding,
} = require('../services/unitLateFee.service');

const UNIT_ID = '507f1f77bcf86cd799439011';
const HOA_ID = '507f1f77bcf86cd799439022';
const SOURCE_INVOICE_ID = '507f1f77bcf86cd799439099';

const hoaLateFeeConfig = {
  enabled: true,
  initialType: 'percentage',
  initialPercentage: 10,
  dailyEnabled: true,
  dailyType: 'flat',
  dailyAmount: 1,
  maxAmount: 30
};

const buildSourceInvoiceDoc = (overrides = {}) => ({
  _id: SOURCE_INVOICE_ID,
  invoiceId: 'INV123456',
  type: 'HOA Fee',
  status: 'Overdue',
  dueDate: '2026-07-04',
  subAmount: 100,
  principalSubAmount: 100,
  balanceDue: 100,
  alreadyPaid: 0,
  term: 'July 2026',
  tenants: ['507f1f77bcf86cd799439012'],
  unit: 'Unit 101',
  createdBy: '507f1f77bcf86cd799439013',
  invoiceItemDetails: [{
    invoiceItem: 'HOA Fee',
    description: 'July 2026',
    quantity: 1,
    rate: 100,
    amount: 100,
  }],
  lateFeeHistory: [],
  comments: [],
  isDeleted: false,
  save: async function saveMock() {
    return this;
  },
  ...overrides,
});

describe('Unit late fee generation', () => {
  let originalPropertyFindOne;
  let originalInvoiceFind;
  let originalInvoiceFindOne;
  let originalInvoiceFindById;
  let originalInvoiceUpdateOne;
  let originalHoaSettingsFindOne;
  let sourceInvoiceDoc;

  beforeEach(() => {
    sourceInvoiceDoc = buildSourceInvoiceDoc();

    originalPropertyFindOne = Property.findOne;
    originalInvoiceFind = Invoice.find;
    originalInvoiceFindOne = Invoice.findOne;
    originalInvoiceFindById = Invoice.findById;
    originalInvoiceUpdateOne = Invoice.updateOne;
    originalHoaSettingsFindOne = HOASettings.findOne;

    HOASettings.findOne = () => ({
      lean: async () => ({
        hoaId: HOA_ID,
        paymentTerm: { gracePeriodDays: 1 },
        lateFee: hoaLateFeeConfig
      })
    });

    Property.findOne = () => ({
      select() {
        return {
          lean: async () => ({
            _id: UNIT_ID,
            hoaId: HOA_ID,
            name: 'Building A',
            unitDetails: [{ unitName: 'Unit 101' }],
            propertySettings: { lateFees: [] }
          })
        };
      }
    });

    Invoice.find = (query) => {
      if (query?.generatedFrom === 'late_fee') {
        return {
          sort() {
            return {
              lean: async () => []
            };
          }
        };
      }
      return {
        select() {
          return {
            lean: async () => [sourceInvoiceDoc]
          };
        }
      };
    };

    Invoice.findOne = () => ({
      select() {
        return {
          lean: async () => null
        };
      }
    });

    Invoice.findById = async (id) => {
      if (String(id) === String(SOURCE_INVOICE_ID)) {
        return sourceInvoiceDoc;
      }
      return null;
    };

    Invoice.updateOne = async () => ({});
  });

  afterEach(() => {
    Property.findOne = originalPropertyFindOne;
    Invoice.find = originalInvoiceFind;
    Invoice.findOne = originalInvoiceFindOne;
    Invoice.findById = originalInvoiceFindById;
    Invoice.updateOne = originalInvoiceUpdateOne;
    HOASettings.findOne = originalHoaSettingsFindOne;
  });

  it('calculates percentage outstanding late fees correctly (legacy)', () => {
    const amount = calculateLateFeeAmount(
      { lateFeeType: 'percentage-outstanding', feeAmount: 10, chargeEachUnpaidTenat: false },
      { balanceDue: 250, subAmount: 500, principalSubAmount: 250, tenants: ['owner-1'], alreadyPaid: 0 }
    );
    assert.equal(amount, 25);
  });

  it('calculates HOA initial late fee on principal outstanding', () => {
    const amount = calculateHoaLateFeeAmount(
      hoaLateFeeConfig,
      { balanceDue: 100, principalSubAmount: 100, alreadyPaid: 0 },
      1
    );
    assert.equal(amount, 10);
  });

  it('calculates HOA initial late fee on partial principal outstanding', () => {
    const amount = calculateHoaLateFeeAmount(
      hoaLateFeeConfig,
      { balanceDue: 50, principalSubAmount: 100, alreadyPaid: 50 },
      1
    );
    assert.equal(amount, 5);
  });

  it('uses principal outstanding rather than accumulated late fees for percentage fees', () => {
    const outstanding = getPrincipalOutstanding({
      principalSubAmount: 100,
      subAmount: 112,
      alreadyPaid: 0,
      lateFeeHistory: [{ amount: 12 }],
    });
    assert.equal(outstanding, 100);
  });

  it('does not charge HOA late fees during grace period', () => {
    const count = getHoaMaxLateFeeSequence(
      1,
      hoaLateFeeConfig,
      { dueDate: '2026-07-04' },
      new Date('2026-07-05')
    );
    assert.equal(count, 0);
  });

  it('charges initial HOA late fee the day after grace ends', () => {
    const count = getHoaMaxLateFeeSequence(
      1,
      hoaLateFeeConfig,
      { dueDate: '2026-07-04' },
      new Date('2026-07-06')
    );
    assert.equal(count, 1);
  });

  it('adds daily HOA late fees after the initial fee day', () => {
    const count = getHoaMaxLateFeeSequence(
      1,
      hoaLateFeeConfig,
      { dueDate: '2026-07-04' },
      new Date('2026-07-08')
    );
    assert.equal(count, 3);
  });

  it('caps repeat late fees by repeatEndAfter (legacy)', () => {
    const count = getMaxSequenceForRule(
      { gracePeriod: 4, isRepeat: true, repeatEvery: 7, repeatEndAfter: 3 },
      { dueDate: '2026-01-01' },
      new Date('2026-02-20')
    );
    assert.equal(count, 3);
  });

  // INV-SC-025: never apply late fees before the invoice due date (grace=0 treats daysLate=0 as ineligible)
  it('INV-SC-025: grace=0 does not treat future or due-today invoices as late', () => {
    const rule = { gracePeriod: 0, isRepeat: true, repeatEvery: 30, repeatEndAfter: null };

    assert.equal(
      getMaxSequenceForRule(rule, { dueDate: '2026-10-01' }, new Date('2026-09-05')),
      0,
      'future invoice must not be eligible'
    );
    assert.equal(
      getMaxSequenceForRule(rule, { dueDate: '2026-09-01' }, new Date('2026-09-01')),
      0,
      'due-today with grace=0 must not be eligible (applies day after due)'
    );
    assert.equal(
      getMaxSequenceForRule(rule, { dueDate: '2026-09-01' }, new Date('2026-09-02')),
      1,
      'day after due with grace=0 is first eligible day'
    );
    assert.equal(
      getMaxSequenceForRule(rule, { dueDate: '2026-08-01' }, new Date('2026-09-05')),
      2,
      'past unpaid invoice accrues initial + 30-day repeat'
    );
  });

  it('INV-SC-025: repeatEndAfter null means never (uncapped)', () => {
    const count = getMaxSequenceForRule(
      { gracePeriod: 0, isRepeat: true, repeatEvery: 30, repeatEndAfter: null },
      { dueDate: '2026-01-01' },
      new Date('2026-05-01')
    );
    // daysLate=120 → first on day 1, then every 30 → sequences at days 1,31,61,91 → 4
    assert.equal(count, 4);
  });

  it('calculates percentage-total late fees correctly (legacy)', () => {
    const amount = calculateLateFeeAmount(
      { lateFeeType: 'percentage-total', feeAmount: 5, chargeEachUnpaidTenat: false },
      { balanceDue: 80, subAmount: 100, principalSubAmount: 100, tenants: ['owner-1'], alreadyPaid: 20 }
    );
    assert.equal(amount, 5);
  });

  it('calculates flat-fee late fees correctly (legacy)', () => {
    const amount = calculateLateFeeAmount(
      { lateFeeType: 'flat-fee', feeAmount: 25, chargeEachUnpaidTenat: false },
      { balanceDue: 100, subAmount: 100, principalSubAmount: 100, tenants: ['owner-1'], alreadyPaid: 0 }
    );
    assert.equal(amount, 25);
  });

  it('applies initial HOA late fee to the source invoice after grace period', async () => {
    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-07-06') });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].amount, 10);
    assert.equal(applied[0].lateFeeSequence, 1);
    assert.equal(sourceInvoiceDoc.subAmount, 110);
    assert.equal(sourceInvoiceDoc.balanceDue, 110);
    assert.equal(sourceInvoiceDoc.principalSubAmount, 100);
    assert.equal(sourceInvoiceDoc.lateFeeHistory.length, 1);
    assert.equal(sourceInvoiceDoc.invoiceItemDetails.length, 2);
  });

  it('applies initial and daily HOA late fees to the source invoice', async () => {
    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-07-08') });
    assert.equal(applied.length, 3);
    assert.deepEqual(applied.map((row) => row.amount), [10, 1, 1]);
    assert.deepEqual(applied.map((row) => row.lateFeeSequence), [1, 2, 3]);
    assert.equal(sourceInvoiceDoc.subAmount, 112);
    assert.equal(sourceInvoiceDoc.balanceDue, 112);
    assert.equal(sourceInvoiceDoc.lateFeeHistory.length, 3);
  });

  it('does not apply the same late fee sequence twice', async () => {
    sourceInvoiceDoc.lateFeeHistory = [{
      lateFeeRuleKey: 'hoa-late-fee',
      lateFeeSequence: 1,
      amount: 10,
    }];
    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-07-06') });
    assert.equal(applied.length, 0);
    assert.equal(sourceInvoiceDoc.subAmount, 100);
  });

  it('applies a legacy late fee rule to the source invoice', async () => {
    HOASettings.findOne = () => ({
      lean: async () => null
    });

    Property.findOne = () => ({
      select() {
        return {
          lean: async () => ({
            _id: UNIT_ID,
            name: 'Building A',
            unitDetails: [{ unitName: 'Unit 101' }],
            propertySettings: {
              lateFees: [{
                _id: 'late-rule-1',
                lateFeeType: 'flat-fee',
                feeAmount: 250,
                gracePeriod: 4,
                isRepeat: false,
                applicableUnits: ['Unit 101'],
                applyTo: 'rent-only',
                chargeEachUnpaidTenat: false
              }]
            }
          })
        };
      }
    });

    sourceInvoiceDoc = buildSourceInvoiceDoc({
      type: 'Rent',
      dueDate: '2026-01-01',
      subAmount: 500,
      principalSubAmount: 500,
      balanceDue: 500,
      term: 'January 2026',
    });

    Invoice.find = (query) => {
      if (query?.generatedFrom === 'late_fee') {
        return {
          sort() {
            return { lean: async () => [] };
          }
        };
      }
      return {
        select() {
          return { lean: async () => [sourceInvoiceDoc] };
        }
      };
    };

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-01-10') });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].amount, 250);
    assert.equal(sourceInvoiceDoc.subAmount, 750);
    assert.equal(sourceInvoiceDoc.balanceDue, 750);
  });

  it('does not apply late fees to opening-balance (Past Due Balance) invoices', async () => {
    sourceInvoiceDoc = buildSourceInvoiceDoc({
      term: 'Past Due Balance',
      generatedFrom: 'opening_balance',
      skipAutoLateFees: true,
      dueDate: '2026-06-01',
      subAmount: 300,
      principalSubAmount: 300,
      balanceDue: 300,
    });

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-06-15') });
    assert.equal(applied.length, 0);
    assert.equal(sourceInvoiceDoc.subAmount, 300);
    assert.equal(sourceInvoiceDoc.balanceDue, 300);
    assert.equal(sourceInvoiceDoc.lateFeeHistory.length, 0);
  });

  it('strips previously applied late fees from opening-balance invoices', async () => {
    sourceInvoiceDoc = buildSourceInvoiceDoc({
      term: 'Past Due Balance',
      generatedFrom: 'unit_schedule',
      skipAutoLateFees: false,
      dueDate: '2026-06-01',
      subAmount: 330,
      principalSubAmount: 300,
      balanceDue: 330,
      lateFeeHistory: [{
        lateFeeRuleKey: 'hoa-late-fee',
        lateFeeSequence: 1,
        amount: 30,
        source: 'system',
      }],
      invoiceItemDetails: [
        {
          invoiceItem: 'Past Due Balance',
          description: 'Opening balance',
          quantity: 1,
          rate: 300,
          amount: 300,
        },
        {
          invoiceItem: 'Initial Late Fee',
          description: 'Late fee',
          quantity: 1,
          rate: 30,
          amount: 30,
        },
      ],
    });

    let saved = false;
    Invoice.findById = () => Promise.resolve({
      ...sourceInvoiceDoc,
      isDeleted: false,
      alreadyPaid: 0,
      comments: [],
      save: async function saveMock() {
        Object.assign(sourceInvoiceDoc, this);
        saved = true;
        return this;
      },
    });

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-06-15') });
    assert.equal(applied.length, 0);
    assert.equal(saved, true);
    assert.equal(sourceInvoiceDoc.subAmount, 300);
    assert.equal(sourceInvoiceDoc.balanceDue, 300);
    assert.equal(sourceInvoiceDoc.lateFeeHistory.length, 0);
    assert.equal(sourceInvoiceDoc.invoiceItemDetails.length, 1);
    assert.equal(sourceInvoiceDoc.skipAutoLateFees, true);
    assert.equal(sourceInvoiceDoc.generatedFrom, 'opening_balance');
  });

  it('INV-SC-025: does not apply multi-rule late fees to future invoices (grace=0)', async () => {
    HOASettings.findOne = () => ({
      lean: async () => ({
        hoaId: HOA_ID,
        paymentTerm: { gracePeriodDays: 0 },
        lateFees: [{
          _id: 'hoa-rule-1',
          lateFeeType: 'percentage-outstanding',
          feeAmount: 5,
          gracePeriod: 0,
          isRepeat: true,
          repeatEvery: 30,
          repeatEndAfter: null,
          applicableScope: 'all',
          applicableUnits: [],
          chargeEachUnpaidTenat: false,
        }],
      }),
    });

    sourceInvoiceDoc = buildSourceInvoiceDoc({
      status: 'Pending',
      dueDate: '2026-10-01',
      term: 'October 2026',
      subAmount: 100,
      principalSubAmount: 100,
      balanceDue: 100,
    });

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-09-05') });
    assert.equal(applied.length, 0);
    assert.equal(sourceInvoiceDoc.subAmount, 100);
    assert.equal(sourceInvoiceDoc.balanceDue, 100);
    assert.equal(sourceInvoiceDoc.lateFeeHistory.length, 0);
  });

  it('INV-SC-025: applies multi-rule percentage-outstanding only after due date', async () => {
    HOASettings.findOne = () => ({
      lean: async () => ({
        hoaId: HOA_ID,
        paymentTerm: { gracePeriodDays: 0 },
        lateFees: [{
          _id: 'hoa-rule-1',
          lateFeeType: 'percentage-outstanding',
          feeAmount: 5,
          gracePeriod: 0,
          isRepeat: true,
          repeatEvery: 30,
          repeatEndAfter: null,
          applicableScope: 'all',
          applicableUnits: [],
          chargeEachUnpaidTenat: false,
        }],
      }),
    });

    sourceInvoiceDoc = buildSourceInvoiceDoc({
      status: 'Overdue',
      dueDate: '2026-09-01',
      term: 'September 2026',
      subAmount: 100,
      principalSubAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = (query) => {
      if (query?.generatedFrom === 'late_fee') {
        return { sort() { return { lean: async () => [] }; } };
      }
      return { select() { return { lean: async () => [sourceInvoiceDoc] }; } };
    };

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-09-05') });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].amount, 5);
    assert.equal(sourceInvoiceDoc.subAmount, 105);
    assert.equal(sourceInvoiceDoc.balanceDue, 105);
  });

  it('INV-SC-025: strips premature late fees from future invoices', async () => {
    HOASettings.findOne = () => ({
      lean: async () => ({
        hoaId: HOA_ID,
        paymentTerm: { gracePeriodDays: 0 },
        lateFees: [{
          _id: 'hoa-rule-1',
          lateFeeType: 'percentage-outstanding',
          feeAmount: 5,
          gracePeriod: 0,
          isRepeat: false,
          applicableScope: 'all',
          applicableUnits: [],
        }],
      }),
    });

    sourceInvoiceDoc = buildSourceInvoiceDoc({
      status: 'Pending',
      dueDate: '2027-01-01',
      term: 'January 2027',
      subAmount: 105,
      principalSubAmount: 100,
      balanceDue: 105,
      lateFeeHistory: [{
        lateFeeRuleKey: 'rule-hoa-rule-1',
        lateFeeSequence: 1,
        amount: 5,
        source: 'system',
      }],
      invoiceItemDetails: [
        {
          invoiceItem: 'Monthly Fee',
          description: 'Monthly Recurring Fee',
          quantity: 1,
          rate: 100,
          amount: 100,
        },
        {
          invoiceItem: 'Late Fee',
          description: 'Late fee for January 2027, applied immediately after due date. Charge amount: $5.00.',
          quantity: 1,
          rate: 5,
          amount: 5,
        },
      ],
    });

    let saved = false;
    Invoice.findById = () => Promise.resolve({
      ...sourceInvoiceDoc,
      isDeleted: false,
      alreadyPaid: 0,
      comments: [],
      save: async function saveMock() {
        Object.assign(sourceInvoiceDoc, this);
        saved = true;
        return this;
      },
    });

    Invoice.find = (query) => {
      if (query?.generatedFrom === 'late_fee') {
        return { sort() { return { lean: async () => [] }; } };
      }
      return { select() { return { lean: async () => [sourceInvoiceDoc] }; } };
    };

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-09-05') });
    assert.equal(applied.length, 0);
    assert.equal(saved, true);
    assert.equal(sourceInvoiceDoc.subAmount, 100);
    assert.equal(sourceInvoiceDoc.balanceDue, 100);
    assert.equal(sourceInvoiceDoc.lateFeeHistory.length, 0);
    assert.equal(sourceInvoiceDoc.invoiceItemDetails.length, 1);
  });

  it('INV-SC-025: multi-rule flat-fee applies after due date only', async () => {
    HOASettings.findOne = () => ({
      lean: async () => ({
        hoaId: HOA_ID,
        paymentTerm: { gracePeriodDays: 0 },
        lateFees: [{
          _id: 'hoa-rule-flat',
          lateFeeType: 'flat-fee',
          feeAmount: 15,
          gracePeriod: 0,
          isRepeat: false,
          applicableScope: 'all',
          applicableUnits: [],
        }],
      }),
    });

    sourceInvoiceDoc = buildSourceInvoiceDoc({
      status: 'Overdue',
      dueDate: '2026-08-01',
      term: 'August 2026',
      subAmount: 100,
      principalSubAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = (query) => {
      if (query?.generatedFrom === 'late_fee') {
        return { sort() { return { lean: async () => [] }; } };
      }
      return { select() { return { lean: async () => [sourceInvoiceDoc] }; } };
    };

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-09-05') });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].amount, 15);
  });

  it('INV-SC-025: multi-rule percentage-total uses principal total not outstanding', async () => {
    HOASettings.findOne = () => ({
      lean: async () => ({
        hoaId: HOA_ID,
        paymentTerm: { gracePeriodDays: 0 },
        lateFees: [{
          _id: 'hoa-rule-pct-total',
          lateFeeType: 'percentage-total',
          feeAmount: 10,
          gracePeriod: 0,
          isRepeat: false,
          applicableScope: 'all',
          applicableUnits: [],
        }],
      }),
    });

    sourceInvoiceDoc = buildSourceInvoiceDoc({
      status: 'Partially Paid',
      dueDate: '2026-08-01',
      term: 'August 2026',
      subAmount: 100,
      principalSubAmount: 100,
      alreadyPaid: 40,
      balanceDue: 60,
    });

    Invoice.find = (query) => {
      if (query?.generatedFrom === 'late_fee') {
        return { sort() { return { lean: async () => [] }; } };
      }
      return { select() { return { lean: async () => [sourceInvoiceDoc] }; } };
    };

    const applied = await ensureLateFeeInvoicesForUnit(UNIT_ID, { today: new Date('2026-09-05') });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].amount, 10); // 10% of $100 principal, not of $60 outstanding
  });
});
