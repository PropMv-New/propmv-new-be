const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const ledgerService = require('../services/ledger.service');
const Invoice = require('../../invoice/model/invoice.model');
const Property = require('../../property/model/property.model');
const LedgerEntry = require('../models/ledgerEntry.model');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');

function makeInvoice({
  id = new mongoose.Types.ObjectId(),
  propertyId,
  invoiceId,
  status,
  dueDate,
  subAmount,
  alreadyPaid = 0,
  balanceDue,
}) {
  return {
    _id: id,
    propertyId,
    invoiceId,
    status,
    dueDate: new Date(dueDate),
    subAmount,
    alreadyPaid,
    balanceDue,
    paymentTransactions: [],
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
  };
}

/** Mirrors production `Invoice.find().lean()` rows used by the open-invoice scan. */
function makeLeanInvoice(opts) {
  const doc = makeInvoice(opts);
  delete doc.save;
  delete doc.saveCalls;
  return doc;
}

function makeThenableQuery(result) {
  return {
    select() { return this; },
    sort() { return this; },
    session() { return this; },
    lean() { return this; },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(result).catch(reject);
    },
  };
}

describe('ledger chronological payment allocation', () => {
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

  it('recognizes only calendar-due outstanding invoices for the prior-balance pass', () => {
    const referenceDate = new Date('2026-07-15T16:00:00Z');

    assert.equal(
      ledgerService.isChronologicalPaymentOutstandingInvoice({
        status: INVOICE_STATUS.PENDING,
        dueDate: new Date('2026-07-15T12:00:00Z'),
        balanceDue: 100,
      }, referenceDate),
      true
    );
    assert.equal(
      ledgerService.isChronologicalPaymentOutstandingInvoice({
        status: INVOICE_STATUS.PARTIALLY_PAID,
        dueDate: new Date('2026-07-14T12:00:00Z'),
        balanceDue: 25,
      }, referenceDate),
      true
    );
    assert.equal(
      ledgerService.isChronologicalPaymentOutstandingInvoice({
        status: INVOICE_STATUS.PENDING,
        dueDate: new Date('2026-09-01T12:00:00Z'),
        balanceDue: 100,
      }, referenceDate),
      false
    );
    assert.equal(
      ledgerService.isChronologicalPaymentOutstandingInvoice({
        status: INVOICE_STATUS.PAID,
        dueDate: new Date('2026-07-01T12:00:00Z'),
        balanceDue: 0,
      }, referenceDate),
      false
    );
  });

  it('applies an insufficient future-invoice payment to oldest prior balances and leaves the future invoice unchanged', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const futureId = new mongoose.Types.ObjectId();
    const priorJune = makeInvoice({
      propertyId,
      invoiceId: 'INV-JUN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-06-01T12:00:00Z',
      subAmount: 50,
      balanceDue: 50,
    });
    const priorJuly = makeInvoice({
      propertyId,
      invoiceId: 'INV-JUL',
      status: INVOICE_STATUS.PARTIALLY_PAID,
      dueDate: '2026-07-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 25,
      balanceDue: 75,
    });
    const futureSeptember = makeInvoice({
      id: futureId,
      propertyId,
      invoiceId: 'INV-SEP',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-09-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const ledgerEntries = [];

    Invoice.findOne = () => makeThenableQuery(futureSeptember);
    Invoice.find = () => makeThenableQuery([priorJune, priorJuly, futureSeptember]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      ledgerEntries.push(this.toObject ? this.toObject() : this);
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: futureId,
      paymentAmount: 75,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-07-15T15:00:00Z') },
    });

    assert.equal(priorJune.status, INVOICE_STATUS.PAID);
    assert.equal(priorJune.balanceDue, 0);
    assert.equal(priorJuly.status, INVOICE_STATUS.PARTIALLY_PAID);
    assert.equal(priorJuly.balanceDue, 50);
    assert.equal(futureSeptember.status, INVOICE_STATUS.PENDING);
    assert.equal(futureSeptember.balanceDue, 100);
    assert.equal(result.appliedToPrimary, 0);
    assert.equal(result.creditStored, 0);
    assert.deepEqual(result.appliedToOtherInvoices.map((row) => row.invoiceNumber), ['INV-JUN', 'INV-JUL']);
    assert.equal(ledgerEntries.some((entry) => entry.type === 'payment'), true);
    assert.equal(
      Array.isArray(futureSeptember.editHistory) && futureSeptember.editHistory.length === 1,
      true
    );
    assert.match(
      futureSeptember.editHistory[0].changes.join(' '),
      /applied to oldest outstanding invoices/i
    );
    assert.match(
      priorJune.paymentTransactions[0].note,
      /overdue invoice/i
    );
  });

  it('INV-SC-028: reloads persistable invoices when the open-invoice scan is lean', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const olderId = new mongoose.Types.ObjectId();
    const selectedId = new mongoose.Types.ObjectId();
    const invoiceOpts = {
      older: {
        id: olderId,
        propertyId,
        invoiceId: 'INV-OPEN',
        status: INVOICE_STATUS.OVERDUE,
        dueDate: '2025-12-13T12:00:00Z',
        subAmount: 1000,
        balanceDue: 1000,
      },
      selected: {
        id: selectedId,
        propertyId,
        invoiceId: 'INV-FEE',
        status: INVOICE_STATUS.OVERDUE,
        dueDate: '2025-12-13T12:00:00Z',
        subAmount: 110,
        balanceDue: 110,
      },
    };
    const olderLean = makeLeanInvoice(invoiceOpts.older);
    const selectedLean = makeLeanInvoice(invoiceOpts.selected);
    const olderDoc = makeInvoice(invoiceOpts.older);
    const selectedDoc = makeInvoice(invoiceOpts.selected);
    olderDoc.createdAt = new Date('2026-09-13T08:48:29.000Z');
    selectedDoc.createdAt = new Date('2026-09-13T08:48:29.100Z');
    olderLean.createdAt = olderDoc.createdAt;
    selectedLean.createdAt = selectedDoc.createdAt;
    const ledgerEntries = [];

    Invoice.find = () => makeThenableQuery([olderLean, selectedLean]);
    Invoice.findOne = (query = {}) => {
      const id = String(query._id || '');
      if (id === String(olderId)) return makeThenableQuery(olderDoc);
      if (id === String(selectedId)) return makeThenableQuery(selectedDoc);
      return makeThenableQuery(null);
    };
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit 5' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      ledgerEntries.push(this.toObject ? this.toObject() : this);
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: selectedId,
      paymentAmount: 1000,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-09-13T14:10:51.758Z') },
    });

    assert.equal(olderDoc.status, INVOICE_STATUS.PAID);
    assert.equal(olderDoc.balanceDue, 0);
    assert.equal(olderDoc.saveCalls > 0, true);
    assert.equal(selectedDoc.saveCalls > 0, true);
    assert.equal(result.appliedToPrimary, 0);
    assert.equal(result.creditStored, 0);
    assert.deepEqual(result.appliedToOtherInvoices.map((row) => row.invoiceNumber), ['INV-OPEN']);
    assert.equal(result.appliedToOtherInvoices[0].amount, 1000);
    assert.equal(ledgerEntries.some((entry) => entry.type === 'payment'), true);
    assert.equal(
      (selectedDoc.paymentTransactions || []).some((tx) => tx.fifoAllocationRole === 'recorded_only'),
      true
    );
  });

  it('rejects online payment on a newer invoice when an older invoice is partially processing', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.PROCESSING,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 60,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = () => makeThenableQuery([older]);

    await assert.rejects(
      () => ledgerService.assertOwnerOnlinePaymentAllowed(newer, 100),
      /oldest unpaid invoice/i
    );
  });

  it('allows online payment on the next invoice when the oldest is fully processing (balance 0)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.PROCESSING,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 0,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = () => makeThenableQuery([older]);

    await assert.doesNotReject(() =>
      ledgerService.assertOwnerOnlinePaymentAllowed(newer, 100)
    );
  });

  it('allows multi-invoice Pay Total when earlier batch allocations cover older overdue invoices', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const olderId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      id: olderId,
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = () => makeThenableQuery([older]);

    await assert.rejects(
      () => ledgerService.assertOwnerOnlinePaymentAllowed(newer, 100),
      /oldest unpaid invoice/i
    );

    await assert.doesNotReject(() =>
      ledgerService.assertOwnerOnlinePaymentAllowed(newer, 100, null, {
        batchCoveredBalances: new Map([[String(olderId), 100]]),
      })
    );

    await assert.doesNotReject(() =>
      ledgerService.assertOwnerOnlinePaymentAllowed(newer, 100, null, {
        coveredInvoiceIds: [String(olderId)],
      })
    );
  });

  it('still blocks when a batch allocation only partially covers an older invoice', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const olderId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      id: olderId,
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = () => makeThenableQuery([older]);

    await assert.rejects(
      () => ledgerService.assertOwnerOnlinePaymentAllowed(newer, 100, null, {
        batchCoveredBalances: new Map([[String(olderId), 40]]),
      }),
      /oldest unpaid invoice/i
    );
  });

  it('board overpayment does not prepay future invoices when allocateFutureInvoices is false', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const jan = makeInvoice({
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const dec = makeInvoice({
      propertyId,
      invoiceId: 'INV-DEC',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-12-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const propertyUpdates = [];

    Invoice.findOne = () => makeThenableQuery(jan);
    Invoice.find = () => makeThenableQuery([jan, dec]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async (id, update) => {
      propertyUpdates.push({ id, update });
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: jan._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-07-15T15:00:00Z') },
      allocateFutureInvoices: false,
    });

    assert.equal(jan.status, INVOICE_STATUS.PAID);
    assert.equal(jan.balanceDue, 0);
    assert.equal(dec.status, INVOICE_STATUS.PENDING);
    assert.equal(dec.balanceDue, 100);
    assert.equal(result.appliedToPrimary, 100);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
  });

  it('board $210 on Invoice B stores excess as credit and does not prepay later invoices', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceC = makeInvoice({
      propertyId,
      invoiceId: 'INV-MAR',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const propertyUpdates = [];

    Invoice.findOne = () => makeThenableQuery(invoiceB);
    Invoice.find = () => makeThenableQuery([invoiceA, invoiceB, invoiceC]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async (id, update) => {
      propertyUpdates.push({ id, update });
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 210,
      paymentMeta: { method: 'Check', paidAt: new Date('2026-02-15T15:00:00Z') },
      allocateFutureInvoices: false,
    });

    assert.equal(invoiceA.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceB.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(invoiceC.status, INVOICE_STATUS.PENDING);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(invoiceC.paymentTransactions.length, 0);
    assert.equal(result.appliedToPrimary, 100);
    assert.equal(result.creditStored, 10);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 10);
    assert.equal(
      invoiceB.paymentTransactions.some((tx) => tx.method === 'Credit Balance' && tx.amount === 10),
      true
    );
  });

  it('board overpayment on selected invoice alone stores remainder as credit without prepaid futures', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceC = makeInvoice({
      propertyId,
      invoiceId: 'INV-MAR',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const propertyUpdates = [];

    Invoice.findOne = () => makeThenableQuery(invoiceB);
    Invoice.find = () => makeThenableQuery([invoiceB, invoiceC]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async (id, update) => {
      propertyUpdates.push({ id, update });
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 210,
      paymentMeta: { method: 'Check', paidAt: new Date('2026-02-15T15:00:00Z') },
      allocateFutureInvoices: false,
    });

    assert.equal(invoiceB.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(invoiceC.status, INVOICE_STATUS.PENDING);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(result.appliedToPrimary, 100);
    assert.equal(result.creditStored, 110);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 110);
  });

  it('plans board allocation to earlier-due + primary only when futures are disabled', () => {
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
    const invoiceC = makeInvoice({
      propertyId,
      invoiceId: 'INV-C',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    const plan = ledgerService.planInvoicePaymentAllocation({
      openInvoices: [invoiceA, invoiceB, invoiceC],
      primaryInvoice: invoiceB,
      paymentAmount: 210,
      allocateFutureInvoices: false,
    });

    assert.deepEqual(
      plan.invoices.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        paymentApplied: row.paymentApplied,
      })),
      [
        { invoiceNumber: 'INV-A', paymentApplied: 100 },
        { invoiceNumber: 'INV-B', paymentApplied: 100 },
      ]
    );
    assert.equal(plan.remainingCredit, 10);
    assert.equal(plan.invoices.some((row) => row.invoiceNumber === 'INV-C'), false);
  });

  it('board overpayment on a same-due-date sibling stores leftover as credit instead of allocating cash', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const first = makeInvoice({
      propertyId,
      invoiceId: 'INV-AUG-17-A',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-17T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const second = makeInvoice({
      propertyId,
      invoiceId: 'INV-AUG-17-B',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-17T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const propertyUpdates = [];

    Invoice.findOne = () => makeThenableQuery(first);
    Invoice.find = () => makeThenableQuery([first, second]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async (id, update) => {
      propertyUpdates.push({ id, update });
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: first._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Check', paidAt: new Date('2026-08-17T15:00:00Z') },
      allocateFutureInvoices: false,
    });

    assert.equal(first.status, INVOICE_STATUS.PAID);
    assert.equal(first.balanceDue, 0);
    assert.equal(second.status, INVOICE_STATUS.PENDING);
    assert.equal(second.balanceDue, 100);
    assert.equal(second.paymentTransactions.length, 0);
    assert.equal(result.appliedToPrimary, 100);
    assert.equal(result.appliedToOtherInvoices.length, 0);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
    assert.equal(
      first.paymentTransactions.some((tx) => tx.method === 'Credit Balance' && tx.amount === 50),
      true
    );
  });

  it('rejects online payment that skips an older unpaid invoice', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = () => makeThenableQuery([older]);

    await assert.rejects(
      () => ledgerService.assertOwnerOnlinePaymentAllowed(newer, 100),
      /oldest unpaid invoice/i
    );
  });

  it('Your payment will first be applied to any outstanding invoices before the selected invoice.', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const jan = makeInvoice({
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const feb = makeInvoice({
      id: new mongoose.Types.ObjectId(),
      propertyId,
      invoiceId: 'INV-FEB',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const mar = makeInvoice({
      propertyId,
      invoiceId: 'INV-MAR',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.findOne = () => makeThenableQuery(feb);
    Invoice.find = () => makeThenableQuery([jan, feb, mar]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: feb._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-07-15T15:00:00Z') },
    });

    assert.equal(jan.status, INVOICE_STATUS.PAID);
    assert.equal(jan.balanceDue, 0);
    assert.equal(feb.status, INVOICE_STATUS.PARTIALLY_PAID);
    assert.equal(feb.balanceDue, 50);
    assert.equal(mar.status, INVOICE_STATUS.OVERDUE);
    assert.equal(mar.balanceDue, 100);
    assert.equal(result.appliedToPrimary, 50);
    assert.equal(result.creditStored, 0);
  });

  it('settles prior balances before applying remainder to the selected future invoice and stores excess as credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const futureId = new mongoose.Types.ObjectId();
    const prior = makeInvoice({
      propertyId,
      invoiceId: 'INV-JUL',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-07-01T12:00:00Z',
      subAmount: 75,
      balanceDue: 75,
    });
    const future = makeInvoice({
      id: futureId,
      propertyId,
      invoiceId: 'INV-SEP',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-09-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const ledgerEntries = [];
    const propertyUpdates = [];

    Invoice.findOne = () => makeThenableQuery(future);
    Invoice.find = () => makeThenableQuery([prior, future]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 10, name: 'Unit A' });
    Property.findByIdAndUpdate = async (id, update) => {
      propertyUpdates.push({ id, update });
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      ledgerEntries.push(this.toObject ? this.toObject() : this);
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: futureId,
      paymentAmount: 200,
      paymentMeta: { method: 'ACH', paidAt: new Date('2026-07-15T15:00:00Z') },
    });

    assert.equal(prior.status, INVOICE_STATUS.PAID);
    assert.equal(prior.balanceDue, 0);
    assert.equal(future.status, INVOICE_STATUS.PAID);
    assert.equal(future.balanceDue, 0);
    assert.equal(result.appliedToPrimary, 100);
    assert.equal(result.creditStored, 25);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 35);
    assert.equal(
      future.paymentTransactions.some((tx) => tx.method === 'Credit Balance' && tx.amount === 25),
      true
    );
    assert.equal(
      ledgerEntries.some((entry) => entry.metadata?.overpaymentCreditStored === 25),
      true
    );
  });

  it('allows online payment on oldest invoice when future generated invoices exist', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const overdue = makeInvoice({
      propertyId,
      invoiceId: 'INV-OVERDUE',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 400,
      balanceDue: 400,
    });
    const future = makeInvoice({
      propertyId,
      invoiceId: 'INV-FUTURE',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.find = () => makeThenableQuery([future]);

    await assert.doesNotReject(() =>
      ledgerService.assertOwnerOnlinePaymentAllowed(overdue, 400)
    );
  });

  it('rejects online payment above the selected invoice balance', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const overdue = makeInvoice({
      propertyId,
      invoiceId: 'INV-OVERDUE',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 400,
      balanceDue: 400,
    });
    const future = makeInvoice({
      propertyId,
      invoiceId: 'INV-FUTURE',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-01T12:00:00Z',
      subAmount: 1200,
      balanceDue: 1200,
    });

    Invoice.find = () => makeThenableQuery([future]);

    await assert.rejects(
      () => ledgerService.assertOwnerOnlinePaymentAllowed(overdue, 1300),
      /cannot exceed this invoice balance/i
    );
  });

  it('FIFO overpayment prepays future generated invoices', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const overdue = makeInvoice({
      propertyId,
      invoiceId: 'INV-OVERDUE',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 400,
      balanceDue: 400,
    });
    const futureA = makeInvoice({
      propertyId,
      invoiceId: 'INV-AUG',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const futureB = makeInvoice({
      propertyId,
      invoiceId: 'INV-SEP',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-09-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.findOne = () => makeThenableQuery(overdue);
    Invoice.find = () => makeThenableQuery([overdue, futureA, futureB]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: overdue._id,
      paymentAmount: 550,
      paymentMeta: { method: 'ACH', paidAt: new Date('2026-07-15T15:00:00Z') },
      allocateFutureInvoices: true,
    });

    assert.equal(overdue.status, INVOICE_STATUS.PAID);
    assert.equal(overdue.balanceDue, 0);
    assert.equal(futureA.status, INVOICE_STATUS.PAID);
    assert.equal(futureA.balanceDue, 0);
    assert.equal(futureB.status, INVOICE_STATUS.PARTIALLY_PAID);
    assert.equal(futureB.balanceDue, 50);
    assert.equal(result.appliedToPrimary, 400);
    assert.equal(result.creditStored, 0);
  });

  it('plans remaining balance on a Processing primary before younger open invoices', () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PROCESSING,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 10,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    // Open allocatable set excludes Processing - mirrors loadOpenAllocatableInvoicesForUnit.
    const planExact = ledgerService.planInvoicePaymentAllocation({
      openInvoices: [invoiceB],
      primaryInvoice: invoiceA,
      paymentAmount: 10,
      allocateFutureInvoices: true,
    });

    assert.deepEqual(
      planExact.invoices.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        paymentApplied: row.paymentApplied,
        isPrimary: row.isPrimary,
      })),
      [{ invoiceNumber: 'INV-A', paymentApplied: 10, isPrimary: true }]
    );
    assert.equal(planExact.remainingCredit, 0);
    assert.equal(planExact.invoices.some((row) => row.invoiceNumber === 'INV-B'), false);

    const planExcess = ledgerService.planInvoicePaymentAllocation({
      openInvoices: [invoiceB],
      primaryInvoice: invoiceA,
      paymentAmount: 20,
      allocateFutureInvoices: true,
    });

    assert.deepEqual(
      planExcess.invoices.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        paymentApplied: row.paymentApplied,
      })),
      [
        { invoiceNumber: 'INV-A', paymentApplied: 10 },
        { invoiceNumber: 'INV-B', paymentApplied: 10 },
      ]
    );
  });

  it('preview applies remaining balance to Processing primary, not the next invoice', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PROCESSING,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 10,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.findOne = () => makeThenableQuery(invoiceA);
    // Allocatable query returns only B (Processing excluded).
    Invoice.find = () => makeThenableQuery([invoiceB]);

    const preview = await ledgerService.previewInvoicePaymentAllocation({
      unitId: propertyId,
      primaryInvoiceId: invoiceA._id,
      paymentAmount: 10,
      allocateFutureInvoices: true,
    });

    assert.equal(preview.hasOlderUnpaidInvoices, false);
    assert.equal(preview.startedFromOldest, true);
    assert.deepEqual(
      preview.invoices.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        paymentApplied: row.paymentApplied,
        isPrimary: row.isPrimary,
      })),
      [{ invoiceNumber: 'INV-A', paymentApplied: 10, isPrimary: true }]
    );
  });

  it('plans FIFO allocation from oldest unpaid invoice and stores leftover as credit', () => {
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
      status: INVOICE_STATUS.PROCESSING,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceC = makeInvoice({
      propertyId,
      invoiceId: 'INV-C',
      status: INVOICE_STATUS.PARTIALLY_PAID,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
    });
    const invoiceD = makeInvoice({
      propertyId,
      invoiceId: 'INV-D',
      status: INVOICE_STATUS.PAID,
      dueDate: '2026-04-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
    });
    const invoiceE = makeInvoice({
      propertyId,
      invoiceId: 'INV-E',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-22T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    const openInvoices = [invoiceA, invoiceB, invoiceC, invoiceD, invoiceE];
    const plan250 = ledgerService.planInvoicePaymentAllocation({
      openInvoices,
      primaryInvoice: invoiceC,
      paymentAmount: 250,
      allocateFutureInvoices: true,
    });

    assert.deepEqual(
      plan250.invoices.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        outstandingBalance: row.outstandingBalance,
        paymentApplied: row.paymentApplied,
        remaining: row.remaining,
      })),
      [
        { invoiceNumber: 'INV-A', outstandingBalance: 100, paymentApplied: 100, remaining: 0 },
        { invoiceNumber: 'INV-C', outstandingBalance: 50, paymentApplied: 50, remaining: 0 },
        { invoiceNumber: 'INV-E', outstandingBalance: 100, paymentApplied: 100, remaining: 0 },
      ]
    );
    assert.equal(plan250.totalPayment, 250);
    assert.equal(plan250.totalApplied, 250);
    assert.equal(plan250.remainingCredit, 0);

    const plan400 = ledgerService.planInvoicePaymentAllocation({
      openInvoices,
      primaryInvoice: invoiceC,
      paymentAmount: 400,
      allocateFutureInvoices: true,
    });
    assert.equal(plan400.totalApplied, 250);
    assert.equal(plan400.remainingCredit, 150);
    assert.equal(plan400.invoices.some((row) => row.invoiceNumber === 'INV-B'), false);
    assert.equal(plan400.invoices.some((row) => row.invoiceNumber === 'INV-D'), false);
  });

  it('preview allocation matches processInvoiceOverpayment amounts', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-JAN',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const primary = makeInvoice({
      propertyId,
      invoiceId: 'INV-MAR',
      status: INVOICE_STATUS.PARTIALLY_PAID,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
    });
    const dueToday = makeInvoice({
      propertyId,
      invoiceId: 'INV-TODAY',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-22T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.findOne = () => makeThenableQuery(primary);
    Invoice.find = () => makeThenableQuery([older, primary, dueToday]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const preview = await ledgerService.previewInvoicePaymentAllocation({
      unitId: propertyId,
      primaryInvoiceId: primary._id,
      paymentAmount: 400,
      allocateFutureInvoices: true,
    });

    assert.equal(preview.hasOlderUnpaidInvoices, true);
    assert.equal(preview.remainingCredit, 150);
    assert.deepEqual(
      preview.invoices.map((row) => row.invoiceNumber),
      ['INV-JAN', 'INV-MAR', 'INV-TODAY']
    );

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: primary._id,
      paymentAmount: 400,
      paymentMeta: { method: 'ACH', paidAt: new Date('2026-08-22T12:00:00Z') },
      allocateFutureInvoices: true,
    });

    const previewPrimary = preview.invoices.find((row) => row.isPrimary);
    const previewOther = preview.invoices
      .filter((row) => !row.isPrimary)
      .reduce((sum, row) => sum + Number(row.paymentApplied || 0), 0);
    const resultOther = result.appliedToOtherInvoices.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    assert.equal(result.appliedToPrimary, previewPrimary?.paymentApplied);
    assert.equal(result.creditStored, preview.remainingCredit);
    assert.equal(Number(resultOther.toFixed(2)), Number(previewOther.toFixed(2)));
  });
});

describe('assertBoardRecordPaymentWithinOutstanding', () => {
  it('allows board record payments above the unit outstanding balance', async () => {
    await assert.doesNotReject(() => (
      ledgerService.assertBoardRecordPaymentWithinOutstanding('unit-id', 1000)
    ));
  });
});

describe('FIFO board payment metadata', () => {
  it('tags cross-invoice allocations when payment is recorded on a later invoice', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-AUG-9',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-09T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-AUG-10',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-10T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.findOne = () => makeThenableQuery(newer);
    Invoice.find = () => makeThenableQuery([older, newer]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: newer._id,
      paymentAmount: 150,
      paymentMeta: {
        method: 'Check',
        recordedBy: new mongoose.Types.ObjectId(),
        paidAt: new Date('2026-08-13T12:00:00Z'),
      },
      allocateFutureInvoices: true,
    });

    assert.equal(older.status, INVOICE_STATUS.PAID);
    assert.equal(older.balanceDue, 0);
    assert.equal(newer.status, INVOICE_STATUS.PARTIALLY_PAID);
    assert.equal(newer.balanceDue, 50);
    assert.equal(result.appliedToPrimary, 50);

    const olderTx = older.paymentTransactions[0];
    assert.equal(olderTx.fifoAllocationRole, 'prior_allocation');
    assert.equal(olderTx.recordedAgainstInvoiceNumber, 'INV-AUG-10');
    assert.equal(olderTx.amount, 100);

    const newerTx = newer.paymentTransactions.find((tx) => tx.fifoAllocationRole === 'self_allocation');
    assert.ok(newerTx);
    assert.equal(newerTx.amount, 50);
    assert.equal(newerTx.recordedPaymentTotal, 150);
    assert.equal(newerTx.fifoRedirectedAmount, 100);
    assert.equal(newerTx.fifoRedirectedToInvoiceNumber, 'INV-AUG-9');
    assert.equal(olderTx.paymentGroupId, newerTx.paymentGroupId);
    assert.ok(Array.isArray(newerTx.fifoRedirectedAllocations));
    assert.equal(newerTx.fifoRedirectedAllocations.length, 1);
    assert.equal(newerTx.fifoRedirectedAllocations[0].amount, 100);
  });

  it('stamps fifoRedirected metadata onto self_allocation at insert time for over-balance spills', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-09T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-10T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    // Capture the self_allocation row as pushed (before any post-hoc mutation).
    const pushedSelfAllocations = [];
    const originalPush = newer.paymentTransactions.push.bind(newer.paymentTransactions);
    newer.paymentTransactions.push = (...args) => {
      for (const row of args) {
        if (row && row.fifoAllocationRole === 'self_allocation') {
          pushedSelfAllocations.push({
            amount: row.amount,
            fifoRedirectedAmount: row.fifoRedirectedAmount,
            fifoRedirectedToInvoiceNumber: row.fifoRedirectedToInvoiceNumber,
            fifoRedirectedAllocations: row.fifoRedirectedAllocations,
          });
        }
      }
      return originalPush(...args);
    };

    Invoice.findOne = () => makeThenableQuery(newer);
    Invoice.find = () => makeThenableQuery([older, newer]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: newer._id,
      paymentAmount: 150,
      paymentMeta: {
        method: 'Check',
        recordedBy: new mongoose.Types.ObjectId(),
        paidAt: new Date('2026-08-13T12:00:00Z'),
      },
      allocateFutureInvoices: false,
    });

    assert.equal(pushedSelfAllocations.length, 1);
    assert.equal(pushedSelfAllocations[0].amount, 50);
    assert.equal(pushedSelfAllocations[0].fifoRedirectedAmount, 100);
    assert.equal(pushedSelfAllocations[0].fifoRedirectedToInvoiceNumber, 'INV-A');
    assert.ok(Array.isArray(pushedSelfAllocations[0].fifoRedirectedAllocations));
    assert.equal(pushedSelfAllocations[0].fifoRedirectedAllocations[0].amount, 100);
  });

  it('marks paymentTransactions modified when cash spills onto the recording invoice', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-09T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-10T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    let markedPaths = [];
    newer.markModified = (path) => {
      markedPaths.push(path);
    };

    Invoice.findOne = () => makeThenableQuery(newer);
    Invoice.find = () => makeThenableQuery([older, newer]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: newer._id,
      paymentAmount: 150,
      paymentMeta: {
        method: 'Check',
        recordedBy: new mongoose.Types.ObjectId(),
        paidAt: new Date('2026-08-13T12:00:00Z'),
      },
      allocateFutureInvoices: false,
    });

    assert.ok(
      markedPaths.includes('paymentTransactions'),
      'expected markModified(paymentTransactions) so redirect fields persist on self_allocation'
    );
    const newerTx = newer.paymentTransactions.find((tx) => tx.fifoAllocationRole === 'self_allocation');
    assert.ok(newerTx);
    assert.equal(newerTx.fifoRedirectedAmount, 100);
  });

  it('builds payment_redirected Activity Timeline for $150 over-balance spill onto Invoice B', async () => {
    const { buildActivityTimelineAndReminderCount } = require('../../invoice/service/invoice.service');
    const propertyId = new mongoose.Types.ObjectId();
    const older = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-09T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const newer = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-08-10T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    Invoice.findOne = () => makeThenableQuery(newer);
    Invoice.find = () => makeThenableQuery([older, newer]);
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: 0, name: 'Unit A' });
    Property.findByIdAndUpdate = async () => null;
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };

    await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: newer._id,
      paymentAmount: 150,
      paymentMeta: {
        method: 'Check',
        recordedBy: new mongoose.Types.ObjectId(),
        paidAt: new Date('2026-08-13T12:00:00Z'),
      },
      allocateFutureInvoices: false,
    });

    const plain = {
      createdAt: newer.createdAt || new Date('2026-08-01T12:00:00Z'),
      paymentTransactions: newer.paymentTransactions,
    };
    const { activityTimeline } = buildActivityTimelineAndReminderCount(plain, new Map());
    const redirected = activityTimeline.find((entry) => entry.kind === 'payment_redirected');
    assert.ok(redirected, 'expected Activity Timeline payment_redirected entry on Invoice B');
    assert.equal(redirected.recordedAmount, 150);
    assert.equal(redirected.appliedToThisInvoice, 50);
    assert.equal(redirected.redirectedAmount, 100);
    assert.equal(redirected.redirectedToInvoiceNumber, 'INV-A');
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment_overpayment'));
    assert.ok(!activityTimeline.some((entry) => entry.kind === 'payment'));
  });
});

describe('payment allocation matrix (board Record Payment defaults)', () => {
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
    Property.findById = () => makeThenableQuery({ _id: propertyId, remainingCredit: propertyCredit, name: 'Unit A' });
    Property.findByIdAndUpdate = async (id, update) => {
      propertyUpdates.push({ id, update });
      return null;
    };
    LedgerEntry.prototype.save = async function saveLedgerEntry() {
      return this;
    };
    return propertyUpdates;
  }

  it('allocates same-due-date invoices by creation order when paying the newest sibling', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-23T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-23T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceC = makeInvoice({
      propertyId,
      invoiceId: 'INV-C',
      status: INVOICE_STATUS.PENDING,
      dueDate: '2026-08-23T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    stubOverpaymentRun({
      propertyId,
      primary: invoiceC,
      openInvoices: [invoiceA, invoiceB, invoiceC],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceC._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-08-23T15:00:00Z') },
    });

    assert.equal(invoiceA.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceB.status, INVOICE_STATUS.PARTIALLY_PAID);
    assert.equal(invoiceB.balanceDue, 50);
    assert.equal(invoiceC.status, INVOICE_STATUS.PENDING);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(result.creditStored, 0);
  });

  it('stores excess as credit when no older invoices remain (scenario 4)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceB = makeInvoice({
      propertyId,
      invoiceId: 'INV-B',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-02-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const propertyUpdates = stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Check', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceB.status, INVOICE_STATUS.PAID);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
  });

  it('stores excess as credit and leaves future invoices unchanged when A is paid (scenario 5)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
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
      openInvoices: [invoiceB, invoiceC],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 210,
      paymentMeta: { method: 'Check', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceB.status, INVOICE_STATUS.PAID);
    assert.equal(invoiceC.status, INVOICE_STATUS.PENDING);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(result.creditStored, 110);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 110);
  });

  it('allocates $250 across four invoices when paying the newest (scenario 10)', async () => {
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
    const invoiceC = makeInvoice({
      propertyId,
      invoiceId: 'INV-C',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-03-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });
    const invoiceD = makeInvoice({
      propertyId,
      invoiceId: 'INV-D',
      status: INVOICE_STATUS.OVERDUE,
      dueDate: '2026-04-01T12:00:00Z',
      subAmount: 100,
      balanceDue: 100,
    });

    stubOverpaymentRun({
      propertyId,
      primary: invoiceD,
      openInvoices: [invoiceA, invoiceB, invoiceC, invoiceD],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceD._id,
      paymentAmount: 250,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-04-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(invoiceC.balanceDue, 50);
    assert.equal(invoiceD.balanceDue, 100);
    assert.deepEqual(
      result.appliedToOtherInvoices.map((row) => row.invoiceNumber),
      ['INV-A', 'INV-B', 'INV-C']
    );
    assert.equal(result.creditStored, 0);
  });

  it('exactly clears three invoices with $300 (scenario 11)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoices = ['INV-A', 'INV-B', 'INV-C'].map((label, index) => makeInvoice({
      propertyId,
      invoiceId: label,
      status: INVOICE_STATUS.OVERDUE,
      dueDate: `2026-0${index + 1}-01T12:00:00Z`,
      subAmount: 100,
      balanceDue: 100,
    }));

    stubOverpaymentRun({
      propertyId,
      primary: invoices[2],
      openInvoices: invoices,
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoices[2]._id,
      paymentAmount: 300,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-03-15T15:00:00Z') },
    });

    assert.equal(invoices.every((inv) => inv.balanceDue === 0), true);
    assert.equal(result.creditStored, 0);
  });

  it('stores $50 credit after clearing three invoices with $350 (scenario 12)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoices = ['INV-A', 'INV-B', 'INV-C'].map((label, index) => makeInvoice({
      propertyId,
      invoiceId: label,
      status: INVOICE_STATUS.OVERDUE,
      dueDate: `2026-0${index + 1}-01T12:00:00Z`,
      subAmount: 100,
      balanceDue: 100,
    }));
    const propertyUpdates = stubOverpaymentRun({
      propertyId,
      primary: invoices[2],
      openInvoices: invoices,
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoices[2]._id,
      paymentAmount: 350,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-03-15T15:00:00Z') },
    });

    assert.equal(invoices.every((inv) => inv.balanceDue === 0), true);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
  });

  it('stores credit when paying the oldest invoice with excess (scenario 13)', async () => {
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
    const propertyUpdates = stubOverpaymentRun({
      propertyId,
      primary: invoiceA,
      openInvoices: [invoiceA, invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceA._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-01-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceB.balanceDue, 100);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
  });

  it('settles a partially paid older invoice before the selected invoice (scenario 14)', async () => {
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
    assert.equal(invoiceB.balanceDue, 60);
    assert.equal(result.appliedToPrimary, 40);
    assert.equal(result.creditStored, 0);
  });

  it('splits payment between partially paid older invoice and selected invoice (scenario 18)', async () => {
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

    await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 100,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceB.balanceDue, 50);
  });

  it('leaves a fully paid older invoice untouched (scenario 15)', async () => {
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
    const propertyUpdates = stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceB],
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 150,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceA.paymentTransactions.length, 0);
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
  });

  it('ignores a waived older invoice (scenario 16)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.WAIVED,
      dueDate: '2026-01-01T12:00:00Z',
      subAmount: 100,
      alreadyPaid: 0,
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
    const propertyUpdates = stubOverpaymentRun({
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

    assert.equal(invoiceA.status, INVOICE_STATUS.WAIVED);
    assert.equal(invoiceA.balanceDue, 100);
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(result.creditStored, 50);
    assert.equal(propertyUpdates[0].update.$set.remainingCredit, 50);
  });

  it('does not allocate cash to a processing older invoice with remaining balance (scenario 17)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const invoiceA = makeInvoice({
      propertyId,
      invoiceId: 'INV-A',
      status: INVOICE_STATUS.PROCESSING,
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

    assert.equal(invoiceA.status, INVOICE_STATUS.PROCESSING);
    assert.equal(invoiceA.balanceDue, 50);
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(result.appliedToPrimary, 100);
    assert.equal(result.creditStored, 0);
  });

  it('does not treat existing property credit as part of a new payment (scenarios 19-20)', async () => {
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
    const propertyUpdates = stubOverpaymentRun({
      propertyId,
      primary: invoiceB,
      openInvoices: [invoiceA, invoiceB],
      propertyCredit: 50,
    });

    const result = await ledgerService.processInvoiceOverpayment({
      unitId: propertyId,
      primaryInvoiceId: invoiceB._id,
      paymentAmount: 100,
      paymentMeta: { method: 'Cash', paidAt: new Date('2026-02-15T15:00:00Z') },
    });

    assert.equal(invoiceA.balanceDue, 0);
    assert.equal(invoiceB.balanceDue, 100);
    assert.equal(result.appliedToPrimary, 0);
    assert.equal(result.creditStored, 0);
    assert.equal(propertyUpdates.length, 0);
  });

  it('excludes consumed overpayment credit from active credit sources', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const groupA = 'pay-a-consumed';
    const invoices = [
      {
        _id: new mongoose.Types.ObjectId(),
        invoiceId: 'INV-A',
        paymentTransactions: [
          {
            amount: 50,
            method: 'Credit Balance',
            note: 'Overpayment of $50.00 stored as credit balance',
            paymentGroupId: groupA,
            isDeleted: false,
          },
        ],
      },
      {
        _id: new mongoose.Types.ObjectId(),
        invoiceId: 'INV-B',
        paymentTransactions: [
          {
            amount: 50,
            method: 'Credit Adjustment',
            note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
            sourcePaymentGroupId: groupA,
            sourceInvoiceNumber: 'INV-A',
            isDeleted: false,
          },
        ],
      },
    ];

    Invoice.find = () => makeThenableQuery(invoices);
    const sources = await ledgerService.findActiveOverpaymentCreditSources(propertyId);
    assert.deepEqual(sources, []);
  });

  it('slices combined credit applications by originating payment (scenarios 22-23)', () => {
    const invoiceAId = new mongoose.Types.ObjectId();
    const invoiceBId = new mongoose.Types.ObjectId();
    const sources = [
      { invoiceId: invoiceAId, invoiceNumber: 'INV-A', paymentGroupId: 'pay-1', amount: 50 },
      { invoiceId: invoiceBId, invoiceNumber: 'INV-B', paymentGroupId: 'pay-2', amount: 75 },
    ];
    const slices = ledgerService.takeCreditSourceSlices(sources, 100);
    assert.deepEqual(
      slices.map((row) => ({
        amount: row.amount,
        sourcePaymentGroupId: row.sourcePaymentGroupId,
        sourceInvoiceNumber: row.sourceInvoiceNumber,
      })),
      [
        { amount: 50, sourcePaymentGroupId: 'pay-1', sourceInvoiceNumber: 'INV-A' },
        { amount: 50, sourcePaymentGroupId: 'pay-2', sourceInvoiceNumber: 'INV-B' },
      ]
    );
    assert.equal(sources[0].amount, 0);
    assert.equal(sources[1].amount, 25);
  });
});
