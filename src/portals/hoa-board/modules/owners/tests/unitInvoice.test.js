const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const invoiceIdHelper = require('../../invoice/helpers/invoiceId.helper');
const { generateUnitInvoices } = require('../services/unitInvoice.service');
const { INVOICE_STATUS, INVOICE_TYPES } = require('../../../../../common/constants/invoice');

describe('Unit Invoice Generation', () => {
  let originalInsertMany;
  let originalAllocateIds;
  let originalPropertyFindById;
  let originalPropertyUpdate;

  let originalInvoiceFind;

  beforeEach(() => {
    originalInsertMany = Invoice.insertMany;
    originalAllocateIds = invoiceIdHelper.allocateUniqueInvoiceIds;
    originalPropertyFindById = Property.findById;
    originalPropertyUpdate = Property.findByIdAndUpdate;
    originalInvoiceFind = Invoice.find;

    Invoice.find = function mockFind() {
      return {
        select() { return this; },
        lean() { return Promise.resolve([]); },
        session() { return this; },
      };
    };

    Invoice.insertMany = async (docs) => docs;

    Property.findById = () => ({
      select() {
        return {
          lean: async () => null,
          session() { return this; },
        };
      },
      session() { return this; },
    });

    Property.findByIdAndUpdate = async () => null;
  });

  afterEach(() => {
    Invoice.insertMany = originalInsertMany;
    Invoice.find = originalInvoiceFind;
    invoiceIdHelper.allocateUniqueInvoiceIds = originalAllocateIds;
    Property.findById = originalPropertyFindById;
    Property.findByIdAndUpdate = originalPropertyUpdate;
  });

  it('creates a separate past due invoice plus monthly invoices for positive starting balance', async () => {
    const { invoices } = await generateUnitInvoices(
      {
        title: 'Test Unit',
        balanceAsOf: '2024-01-01',
        monthlyRecurringFee: 100,
        paymentTerm: 2,
        paymentDueDay: 5,
        startingBalance: 500,
        associatedOwnerIds: ['507f1f77bcf86cd799439012'],
      },
      '507f1f77bcf86cd799439011',
      'Test Property',
      null
    );

    assert.equal(invoices.length, 3);
    assert.equal(invoices[0].type, INVOICE_TYPES.HOA_FEE);
    assert.equal(invoices[0].term, 'Past Due Balance');
    assert.equal(invoices[0].subAmount, 500);
    assert.equal(invoices[0].status, INVOICE_STATUS.OVERDUE);
    assert.equal(invoices[0].generatedFrom, 'opening_balance');
    assert.equal(invoices[0].skipAutoLateFees, true);
    assert.equal(invoices[1].term, 'January 2024');
    assert.equal(invoices[2].term, 'February 2024');
  });

  it('creates paymentTransactions when opening credit is applied to due monthly invoices', async () => {
    const { invoices } = await generateUnitInvoices(
      {
        title: 'Credit Unit',
        balanceAsOf: '2020-01-01',
        monthlyRecurringFee: 100,
        paymentTerm: 1,
        paymentDueDay: 1,
        startingBalance: -100,
        associatedOwnerIds: ['507f1f77bcf86cd799439012'],
      },
      '507f1f77bcf86cd799439011',
      'Test Property',
      null,
      { today: new Date('2025-06-15T12:00:00.000Z') }
    );

    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].term, 'January 2020');
    assert.equal(invoices[0].alreadyPaid, 100);
    assert.equal(invoices[0].balanceDue, 0);
    assert.equal(invoices[0].status, INVOICE_STATUS.PAID);
    assert.ok(Array.isArray(invoices[0].paymentTransactions));
    assert.equal(invoices[0].paymentTransactions.length, 1);
    assert.equal(invoices[0].paymentTransactions[0].method, 'Credit Adjustment');
    assert.equal(invoices[0].paymentTransactions[0].amount, 100);
  });

  it('returns empty when required fields are missing', async () => {
    const { invoices } = await generateUnitInvoices(
      {
        title: 'Test Unit',
        monthlyRecurringFee: 100,
        paymentTerm: 0,
        startingBalance: -100,
        associatedOwnerIds: ['507f1f77bcf86cd799439012'],
      },
      '507f1f77bcf86cd799439011',
      'Test Property',
      null
    );

    assert.deepEqual(invoices, []);
  });

  it('keeps Aug 10 calendar day when balanceAsOf is UTC midnight (not ET-shifted to Aug 9)', async () => {
    const { dateOnlyKeyFromStoredInstant } = require('../../../../../common/helpers/hoaBillingDates');

    const balanceAsOf = new Date('2026-08-10T00:00:00.000Z');
    assert.equal(dateOnlyKeyFromStoredInstant(balanceAsOf), '2026-08-10');

    const { invoices: generated } = await generateUnitInvoices(
      {
        title: 'ET Date Unit',
        balanceAsOf,
        monthlyRecurringFee: 100,
        paymentTerm: 1,
        paymentDueDay: 10,
        startingBalance: 50,
        associatedOwnerIds: ['507f1f77bcf86cd799439012'],
      },
      '507f1f77bcf86cd799439011',
      'Test Property',
      null,
      { today: new Date('2026-08-11T16:00:00.000Z') }
    );

    assert.ok(generated.length >= 1);
    const opening = generated.find((inv) => inv.generatedFrom === 'opening_balance') || generated[0];
    const dueKey = dateOnlyKeyFromStoredInstant(opening.dueDate);
    assert.equal(dueKey, '2026-08-10', `expected Aug 10 due date, got ${dueKey} from ${opening.dueDate}`);
  });
});
