/**
 * Invoice payment / credit edge-case matrix (board Record Payment defaults).
 *
 * Scenario IDs match the QA matrix (MX-01 … MX-30) and Untitled-1 (INV-SC-024).
 * These tests document expected business rules - failures indicate defects, not
 * incomplete fixtures. Do not "fix" by weakening assertions.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const ledgerService = require('../services/ledger.service');
const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const LedgerEntry = require('../models/ledgerEntry.model');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const {
  reverseRecordedPaymentGroup,
  isDownstreamCreditApplication,
  previewRecordedPaymentReversal,
} = require('../../invoice/helpers/invoicePaymentReversal.helper');

function makeInvoice({
  id = new mongoose.Types.ObjectId(),
  propertyId,
  invoiceId,
  status,
  dueDate,
  subAmount,
  alreadyPaid = 0,
  balanceDue,
  createdAt,
  paymentTransactions = [],
}) {
  return {
    _id: id,
    propertyId,
    invoiceId,
    status,
    dueDate: new Date(dueDate),
    createdAt: createdAt ? new Date(createdAt) : new Date(dueDate),
    subAmount,
    alreadyPaid,
    balanceDue,
    paymentTransactions,
    editHistory: [],
    skipAutoCreditApply: false,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
  };
}

function makeThenableQuery(result) {
  const state = { sortSpec: null };
  const api = {
    select() { return this; },
    sort(spec) {
      state.sortSpec = spec;
      return this;
    },
    session() { return this; },
    lean() { return this; },
    then(resolve, reject) {
      let value = result;
      if (Array.isArray(result) && state.sortSpec) {
        value = [...result].sort((left, right) => {
          for (const [field, direction] of Object.entries(state.sortSpec)) {
            const dir = Number(direction) >= 0 ? 1 : -1;
            const lv = left[field];
            const rv = right[field];
            const lTime = lv instanceof Date ? lv.getTime() : (lv != null ? Number(new Date(lv)) || String(lv) : 0);
            const rTime = rv instanceof Date ? rv.getTime() : (rv != null ? Number(new Date(rv)) || String(rv) : 0);
            if (lTime < rTime) return -1 * dir;
            if (lTime > rTime) return 1 * dir;
            if (String(lv) < String(rv)) return -1 * dir;
            if (String(lv) > String(rv)) return 1 * dir;
          }
          return 0;
        });
      }
      return Promise.resolve(value).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(result).catch(reject);
    },
  };
  return api;
}

function makeInvoiceDoc({
  id = new mongoose.Types.ObjectId(),
  propertyId,
  invoiceId,
  subAmount,
  alreadyPaid,
  balanceDue,
  status,
  dueDate,
  paymentTransactions = [],
}) {
  return {
    _id: id,
    propertyId,
    invoiceId,
    subAmount,
    alreadyPaid,
    balanceDue,
    status,
    dueDate,
    paymentTransactions,
    editHistory: [],
    skipAutoCreditApply: false,
    async save() {
      return this;
    },
  };
}

describe('invoice edge-case matrix (allocation)', () => {
  const originals = {};

  beforeEach(() => {
    originals.invoiceFind = Invoice.find;
    originals.invoiceFindOne = Invoice.findOne;
    originals.propertyFindById = Property.findById;
    originals.propertyFindByIdAndUpdate = Property.findByIdAndUpdate;
    originals.ledgerSave = LedgerEntry.prototype.save;
  });

  afterEach(() => {
    Invoice.find = originals.invoiceFind;
    Invoice.findOne = originals.invoiceFindOne;
    Property.findById = originals.propertyFindById;
    Property.findByIdAndUpdate = originals.propertyFindByIdAndUpdate;
    LedgerEntry.prototype.save = originals.ledgerSave;
  });

  function stubOverpaymentRun({
    propertyId,
    primary,
    openInvoices,
    propertyCredit = 0,
  }) {
    const propertyUpdates = [];
    Invoice.findOne = () => makeThenableQuery(primary);
    Invoice.find = () => makeThenableQuery(openInvoices);
    Property.findById = () => makeThenableQuery({
      _id: propertyId,
      remainingCredit: propertyCredit,
      name: 'Unit A',
    });
    Property.findByIdAndUpdate = async (id, update) => {
      propertyUpdates.push({ id, update });
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };
    return propertyUpdates;
  }

  it('MX-01D: $150 on B allocates A=$100 then B=$50, no credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceA, invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceA.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceB.balanceDue, 50);
    assert.equal(invoiceB.status, INVOICE_STATUS.PARTIALLY_PAID);
    assert.equal(result.creditStored, 0);
    assert.equal(result.appliedToPrimary, 50);
  });

  it('INV-SC-026: $550 recorded on B marks A as prior allocation and B as the source', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-25T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-26T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceA, invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 550,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-09-03T11:57:00Z') },
    });

    const allocationOnA = invoiceA.paymentTransactions[0];
    const sourcePaymentOnB = invoiceB.paymentTransactions.find(
      (tx) => tx.fifoAllocationRole === 'self_allocation',
    );
    assert.equal(allocationOnA.fifoAllocationRole, 'prior_allocation');
    assert.equal(String(allocationOnA.recordedAgainstInvoiceId), String(invoiceB._id));
    assert.equal(allocationOnA.recordedAgainstInvoiceNumber, 'INV-B');
    assert.equal(sourcePaymentOnB.fifoAllocationRole, 'self_allocation');
    assert.equal(sourcePaymentOnB.recordedPaymentTotal, 550);
    assert.equal(result.creditStored, 350);
  });

  it('MX-02: $50 on B when A is paid → B partially paid, no credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 50,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceB.balanceDue, 50);
    assert.equal(invoiceB.status, INVOICE_STATUS.PARTIALLY_PAID);
    assert.equal(result.appliedToPrimary, 50);
    assert.equal(result.creditStored, 0);
  });

  it('MX-03: $100 on B when A is paid → B paid, no credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 100,
      paymentMeta: { method: 'Check', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(invoiceB.status, INVOICE_STATUS.PAID);
    assert.equal(result.creditStored, 0);
  });

  it('MX-05 / MX-01F: $210 on B with future C stores $110 credit; C unchanged', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PAID,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceC = makeInvoice({
      propertyId,
      invoiceId: 'INV-C',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const propertyUpdates = stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceA, invoiceB, invoiceC],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 210,
      paymentMeta: { method: 'Check', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceB.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(invoiceC.status, INVOICE_STATUS.PENDING);
    assert.equal(result.creditStored, 110);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 110);
  });

  it('MX-14: $100 on B settles partially paid older A ($60) then B ($40)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PARTIALLY_PAID,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 40,
      balanceDue: 60,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceA, invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 100,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceA.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceB.balanceDue, 60);
    assert.equal(result.appliedToPrimary, 40);
    assert.equal(result.creditStored, 0);
  });

  it('MX-18: $100 on B with A partially paid $50 → A=$50, B=$50', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PARTIALLY_PAID,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceA, invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 100,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceB.balanceDue, 50);
    assert.equal(result.appliedToPrimary, 50);
    assert.equal(result.creditStored, 0);
  });

  it('MX-27: allocates by due date, not creation order', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    // Created first but due later
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-03-01T12:00:00Z',
      createdAt: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    // Created later but due earlier
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      createdAt: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    stubOverpaymentRun({
      propertyId,
      primary: invoiceA,
      openInvoices: [invoiceA, invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceA._id,
      paymentAmount: 100,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-03-15T15:00:00Z') },
    });

    // Oldest due (B / Jan) must be paid first even though payment recorded on A
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(invoiceB.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceA.balanceDue, 100);
    assert.equal(result.appliedToPrimary, 0);
    assert.equal(result.creditStored, 0);
  });

  it('MX-29: $150 on due-today A stores $50 credit; future B unchanged', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-29T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-09-15T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const propertyUpdates = stubOverpaymentRun({
      propertyId,
      primary: invoiceA,
      openInvoices: [invoiceA, invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceA._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-08-29T15:00:00Z') },
      allocateFutureInvoices: false,
    });

    assert.equal(invoiceA.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceB.balanceDue, 100);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
  });
});

describe('invoice edge-case matrix (reversal + credit)', () => {
  const originals = {};
  let remainingCredit = 0;
  let ledgerEntries = [];

  beforeEach(() => {
    remainingCredit = 0;
    ledgerEntries = [];
    originals.invoiceFind = Invoice.find;
    originals.invoiceFindOne = Invoice.findOne;
    originals.propertyFindById = Property.findById;
    originals.propertyFindByIdAndUpdate = Property.findByIdAndUpdate;
    originals.ledgerSave = LedgerEntry.prototype.save;
    originals.ledgerFind = LedgerEntry.find;
    originals.invoiceBulkWrite = Invoice.bulkWrite;

    Property.findById = () => makeThenableQuery({
      _id: new mongoose.Types.ObjectId(),
      remainingCredit,
      name: 'Unit A',
    });
    Property.findByIdAndUpdate = async (_id, update) => {
      if (update?.$set?.remainingCredit != null) {
        remainingCredit = update.$set.remainingCredit;
      }
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      ledgerEntries.push(this.toObject ? this.toObject() : this);
      return this;
    };
    LedgerEntry.find = () => makeThenableQuery([]);
  });

  afterEach(() => {
    Invoice.find = originals.invoiceFind;
    Invoice.findOne = originals.invoiceFindOne;
    Property.findById = originals.propertyFindById;
    Property.findByIdAndUpdate = originals.propertyFindByIdAndUpdate;
    LedgerEntry.prototype.save = originals.ledgerSave;
    LedgerEntry.find = originals.ledgerFind;
    Invoice.bulkWrite = originals.invoiceBulkWrite;
  });

  it('MX-06 / MX-09: downstream auto-applied credit is not independently deletable', () => {
    const creditOnC = {
      amount: 100,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $100.00 from available credit balance',
      sourcePaymentGroupId: 'group-210',
      sourceInvoiceNumber: 'INV-B',
      isDeleted: false,
    };
    assert.equal(isDownstreamCreditApplication(creditOnC), true);

    const previewKind = previewRecordedPaymentReversal;
    assert.equal(typeof previewKind, 'function');
  });

  it('MX-07: removing $210 payment with unused $110 credit zeros the pool', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-210`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 210,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 110,
      method: 'Credit Balance',
      note: 'Overpayment of $110.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const invoiceB = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-B',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });

    remainingCredit = 110;
    Invoice.find = () => makeThenableQuery([]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoiceB,
      tx: paymentTx,
      userId,
    });

    assert.equal(result.totalRemoved, 210);
    assert.equal(paymentTx.isDeleted, true);
    assert.equal(creditStoredTx.isDeleted, true);
    assert.equal(invoiceB.balanceDue, 100);
    assert.equal(remainingCredit, 0);
  });

  it('MX-08: removing $210 after credit applied to C reverses B, C, and leftover credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-210`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 210,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 110,
      method: 'Credit Balance',
      note: 'Overpayment of $110.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const creditAppliedC = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $100.00 from available credit balance',
      sourcePaymentGroupId: groupId,
      sourceInvoiceNumber: 'INV-B',
      isDeleted: false,
    };
    const invoiceB = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-B',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });
    const invoiceC = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-C',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [creditAppliedC],
    });

    remainingCredit = 10;
    Invoice.find = () => makeThenableQuery([invoiceC]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoiceB,
      tx: paymentTx,
      userId,
    });

    assert.equal(result.totalRemoved, 210);
    assert.equal(creditAppliedC.isDeleted, true);
    assert.equal(invoiceB.balanceDue, 100);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(remainingCredit, 0);
  });

  it('MX-21: removing a new $100 payment leaves pre-existing $50 property credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupNew = `${new mongoose.Types.ObjectId()}-new`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Cash',
      paymentGroupId: groupNew,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 100,
      isDeleted: false,
    };
    const invoiceB = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-B',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2026-02-01'),
      paymentTransactions: [paymentTx],
    });

    remainingCredit = 50;
    Invoice.find = () => makeThenableQuery([]);

    await reverseRecordedPaymentGroup({
      invoice: invoiceB,
      tx: paymentTx,
      userId,
    });

    assert.equal(paymentTx.isDeleted, true);
    assert.equal(invoiceB.balanceDue, 100);
    assert.equal(remainingCredit, 50);
  });

  it('INV-SC-024 / Untitled-1: after deleting A $150, D-pool $50 remains then auto-applies to A', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupA = `${new mongoose.Types.ObjectId()}-inv-a`;
    const group550 = `${new mongoose.Types.ObjectId()}-inv-d-550`;

    const paymentATx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      paymentGroupId: groupA,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredATx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupA,
      isDeleted: false,
    };
    const creditAppliedBFromA = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: groupA,
      sourceInvoiceNumber: 'INV-A',
      isDeleted: false,
    };
    const paymentBTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Check',
      status: 'processing',
      note: 'Payment recorded for invoice #INV-B',
      isDeleted: false,
    };
    const paymentDTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      paymentGroupId: group550,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 550,
      isDeleted: false,
    };
    const creditStoredDTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 250,
      method: 'Credit Balance',
      note: 'Overpayment of $250.00 stored as credit balance',
      paymentGroupId: group550,
      isDeleted: false,
    };
    const creditAppliedFFromD = {
      _id: new mongoose.Types.ObjectId(),
      amount: 200,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $200.00 from available credit balance',
      sourcePaymentGroupId: group550,
      sourceInvoiceNumber: 'INV-D',
      isDeleted: false,
    };

    const invoiceA = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-A',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2020-01-01'),
      paymentTransactions: [paymentATx, creditStoredATx],
    });
    const invoiceB = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-B',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 0,
      status: INVOICE_STATUS.PROCESSING,
      dueDate: new Date('2020-02-01'),
      paymentTransactions: [creditAppliedBFromA, paymentBTx],
    });
    const invoiceD = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-D',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2020-04-01'),
      paymentTransactions: [paymentDTx, creditStoredDTx],
    });
    const invoiceF = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-F',
      subAmount: 200,
      alreadyPaid: 200,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2020-06-01'),
      paymentTransactions: [creditAppliedFFromD],
    });

    remainingCredit = 50;
    Invoice.find = () => makeThenableQuery([invoiceB, invoiceD, invoiceF]);

    await reverseRecordedPaymentGroup({
      invoice: invoiceA,
      tx: paymentATx,
      userId,
    });

    assert.equal(paymentATx.isDeleted, true);
    assert.equal(creditAppliedBFromA.isDeleted, true);
    assert.equal(invoiceA.balanceDue, 100);
    assert.equal(invoiceB.balanceDue, 50);
    assert.equal(creditAppliedFFromD.isDeleted, false);
    // D-pool $50 must survive A reversal (not zeroed / not double-counted)
    assert.equal(remainingCredit, 50);

    // Post-delete auto-apply (same path as deleteInvoicePayment → applyAllUnappliedCredit)
    const invoiceById = new Map([
      [String(invoiceA._id), invoiceA],
      [String(invoiceB._id), invoiceB],
      [String(invoiceD._id), invoiceD],
      [String(invoiceF._id), invoiceF],
    ]);

    Invoice.find = () => makeThenableQuery([
      {
        ...invoiceA,
        status: INVOICE_STATUS.OVERDUE,
        balanceDue: 100,
        alreadyPaid: 0,
      },
      invoiceB,
      invoiceD,
      invoiceF,
    ]);
    // Re-bind after status change for auto-apply candidates
    const openA = makeInvoiceDoc({
      id: invoiceA._id,
      propertyId,
      invoiceId: 'INV-A',
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 100,
      status: INVOICE_STATUS.OVERDUE,
      dueDate: new Date('2020-01-01'),
      paymentTransactions: invoiceA.paymentTransactions,
    });
    invoiceById.set(String(openA._id), openA);
    Invoice.find = () => makeThenableQuery([openA, invoiceB, invoiceD, invoiceF]);

    Invoice.bulkWrite = async (ops) => {
      for (const op of ops || []) {
        const id = String(op.updateOne.filter._id);
        const doc = invoiceById.get(id);
        if (!doc) continue;
        Object.assign(doc, op.updateOne.update.$set || {});
        if (op.updateOne.update.$push?.paymentTransactions) {
          doc.paymentTransactions = doc.paymentTransactions || [];
          doc.paymentTransactions.push(op.updateOne.update.$push.paymentTransactions);
        }
      }
      return { ok: 1 };
    };

    Property.findById = () => makeThenableQuery({
      _id: propertyId,
      remainingCredit,
      name: 'Unit A',
    });

    const fakeSession = {};
    const applyResult = await ledgerService.applyPropertyRemainingCreditToDueInvoices(
      propertyId,
      { session: fakeSession },
    );

    assert.equal(applyResult.modified, true);
    assert.equal(remainingCredit, 0);
    assert.equal(openA.balanceDue, 50);
    assert.equal(openA.alreadyPaid, 50);
    assert.equal(openA.status, INVOICE_STATUS.PARTIALLY_PAID);

    const appliedTx = (openA.paymentTransactions || []).find(
      (tx) => tx.method === 'Credit Adjustment' && !tx.isDeleted,
    );
    assert.ok(appliedTx, 'expected auto-applied credit transaction on Invoice A');
    assert.equal(Number(appliedTx.amount), 50);
    assert.equal(appliedTx.sourcePaymentGroupId, group550);
    assert.equal(isDownstreamCreditApplication(appliedTx), true);
  });
});
