const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Invoice = require('../model/invoice.model');
const Property = require('../../property/model/property.model');
const LedgerEntry = require('../../owners/models/ledgerEntry.model');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const {
  reverseRecordedPaymentGroup,
  previewRecordedPaymentReversal,
  recalculateInvoiceTotalsFromTransactions,
  isDownstreamCreditApplication,
} = require('./invoicePaymentReversal.helper');

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

describe('independent credit allocation reversal', () => {
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
  });

  it('removing $50 stored credit keeps invoice 1 paid and unapplies auto-applied credit on invoice 2', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-1`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-1',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const creditAppliedTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: groupId,
      isDeleted: false,
    };

    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });
    const invoice2 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-2',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIALLY_PAID,
      paymentTransactions: [creditAppliedTx],
    });

    remainingCredit = 0;
    Invoice.find = () => makeThenableQuery([invoice2]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoice1,
      tx: creditStoredTx,
      userId,
    });

    assert.equal(result.reversalMode, 'credit_stored');
    assert.equal(creditStoredTx.isDeleted, true);
    assert.equal(paymentTx.isDeleted, false);
    assert.equal(creditAppliedTx.isDeleted, true);
    assert.equal(invoice1.alreadyPaid, 100);
    assert.equal(invoice1.balanceDue, 0);
    assert.equal(invoice1.status, INVOICE_STATUS.PAID);
    assert.equal(invoice2.alreadyPaid, 0);
    assert.equal(invoice2.balanceDue, 100);
    assert.equal(invoice2.skipAutoCreditApply, true);
    // Unapplied from invoice 2 then removed from the property pool → no leftover credit.
    assert.equal(remainingCredit, 0);
  });

  it('removing the original $150 payment reverses invoice 2 credit and stored overpayment credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-2`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-1',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const creditAppliedTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: groupId,
      isDeleted: false,
    };

    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });
    const invoice2 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-2',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIALLY_PAID,
      paymentTransactions: [creditAppliedTx],
    });

    remainingCredit = 0;
    Invoice.find = () => makeThenableQuery([invoice2]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoice1,
      tx: paymentTx,
      userId,
    });

    assert.equal(result.reversalMode, 'payment_allocation');
    assert.equal(result.totalRemoved, 150);
    assert.equal(paymentTx.isDeleted, true);
    assert.equal(creditStoredTx.isDeleted, true);
    assert.equal(creditAppliedTx.isDeleted, true);
    assert.equal(invoice1.alreadyPaid, 0);
    assert.equal(invoice1.balanceDue, 100);
    assert.equal(invoice2.alreadyPaid, 0);
    assert.equal(invoice2.balanceDue, 100);
    assert.equal(remainingCredit, 0);
  });

  it('removing unused stored credit with the $100 payment fully resets remaining credit for a repeat recording', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-3`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-1',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };

    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });

    remainingCredit = 50;
    Invoice.find = () => makeThenableQuery([]);

    await reverseRecordedPaymentGroup({
      invoice: invoice1,
      tx: paymentTx,
      userId,
    });

    assert.equal(paymentTx.isDeleted, true);
    assert.equal(creditStoredTx.isDeleted, true);
    assert.equal(invoice1.alreadyPaid, 0);
    assert.equal(invoice1.balanceDue, 100);
    assert.equal(remainingCredit, 0);
  });

  it('full reversal of stored credit after the $100 payment is gone leaves invoice 2 eligible for the next auto-apply', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-4`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: true,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const creditAppliedTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: groupId,
      isDeleted: false,
    };

    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 100,
      status: INVOICE_STATUS.PENDING,
      paymentTransactions: [paymentTx, creditStoredTx],
    });
    const invoice2 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-2',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIALLY_PAID,
      paymentTransactions: [creditAppliedTx],
    });

    remainingCredit = 0;
    Invoice.find = () => makeThenableQuery([invoice2]);

    await reverseRecordedPaymentGroup({
      invoice: invoice1,
      tx: creditStoredTx,
      userId,
    });

    assert.equal(creditAppliedTx.isDeleted, true);
    assert.equal(invoice2.alreadyPaid, 0);
    assert.equal(invoice2.balanceDue, 100);
    assert.equal(invoice2.skipAutoCreditApply, false);
    assert.equal(remainingCredit, 0);
  });

  it('unapplying a prior allocation returns that amount to available credit only', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const allocationTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Check',
      note: 'Applied $50.00 from payment on invoice #INV-1 (open invoice)',
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-1',
      isDeleted: false,
    };
    const invoice2 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-2',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIALLY_PAID,
      paymentTransactions: [allocationTx],
    });

    remainingCredit = 0;
    Invoice.find = () => makeThenableQuery([]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoice2,
      tx: allocationTx,
      userId,
    });

    assert.equal(result.reversalMode, 'prior_allocation');
    assert.equal(allocationTx.isDeleted, true);
    assert.equal(invoice2.alreadyPaid, 0);
    assert.equal(invoice2.balanceDue, 100);
    assert.equal(remainingCredit, 50);
  });

  it('removing the $100 payment after stored credit was removed separately reclaims orphaned pool credit', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-repeat-1`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-1',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: true,
    };

    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });

    remainingCredit = 50;
    Invoice.find = () => makeThenableQuery([]);

    await reverseRecordedPaymentGroup({
      invoice: invoice1,
      tx: paymentTx,
      userId,
    });

    assert.equal(paymentTx.isDeleted, true);
    assert.equal(invoice1.alreadyPaid, 0);
    assert.equal(invoice1.balanceDue, 100);
    assert.equal(remainingCredit, 0);
  });

  it('removing the original $150 payment also reverses stored credit already applied to invoice 2 on a repeat recording', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-repeat-2`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-1',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const creditAppliedTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: groupId,
      isDeleted: false,
    };

    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });
    const invoice2 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-2',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIALLY_PAID,
      paymentTransactions: [creditAppliedTx],
    });

    remainingCredit = 50;
    Invoice.find = () => makeThenableQuery([invoice2]);

    await reverseRecordedPaymentGroup({
      invoice: invoice1,
      tx: paymentTx,
      userId,
    });

    assert.equal(paymentTx.isDeleted, true);
    assert.equal(creditStoredTx.isDeleted, true);
    assert.equal(creditAppliedTx.isDeleted, true);
    assert.equal(invoice1.alreadyPaid, 0);
    assert.equal(invoice1.balanceDue, 100);
    assert.equal(invoice2.alreadyPaid, 0);
    assert.equal(invoice2.balanceDue, 100);
    assert.equal(remainingCredit, 50);
  });

  it('recalculates invoice 2 as unpaid after its auto-applied credit is removed', () => {
    const totals = recalculateInvoiceTotalsFromTransactions({
      subAmount: 100,
      waivedAmount: 0,
      paymentTransactions: [
        {
          amount: 50,
          method: 'Credit Adjustment',
          note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
          isDeleted: true,
        },
      ],
    });
    assert.deepEqual(totals, { alreadyPaid: 0, processingAmount: 0, balanceDue: 100 });
  });

  it('previews original payment reversal when credit was later applied to another invoice', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-preview-1`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const creditAppliedTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: groupId,
      isDeleted: false,
    };
    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });
    const invoice2 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-2',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIALLY_PAID,
      paymentTransactions: [creditAppliedTx],
    });

    Invoice.find = () => makeThenableQuery([invoice2]);

    const preview = await previewRecordedPaymentReversal({
      invoice: invoice1,
      tx: paymentTx,
    });

    assert.equal(preview.kind, 'payment');
    assert.equal(preview.originalPaymentTotal, 150);
    assert.equal(preview.creditStoredAmount, 50);
    assert.equal(preview.unusedCreditAmount, 0);
    assert.equal(preview.downstreamApplications.length, 1);
    assert.equal(preview.downstreamApplications[0].invoiceNumber, 'INV-2');
    assert.equal(preview.downstreamApplications[0].amount, 50);
    assert.equal(paymentTx.isDeleted, false);
    assert.equal(creditAppliedTx.isDeleted, false);
  });

  it('previews original payment reversal when overpayment credit is still unused', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-preview-2`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const creditStoredTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: groupId,
      isDeleted: false,
    };
    const invoice1 = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-1',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentTx, creditStoredTx],
    });

    Invoice.find = () => makeThenableQuery([]);

    const preview = await previewRecordedPaymentReversal({
      invoice: invoice1,
      tx: paymentTx,
    });

    assert.equal(preview.originalPaymentTotal, 150);
    assert.equal(preview.creditStoredAmount, 50);
    assert.equal(preview.unusedCreditAmount, 50);
    assert.deepEqual(preview.downstreamApplications, []);
  });

  it('removing the original payment reverses prior allocations on earlier invoices', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-fifo-remove-1`;
    const priorAllocationTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Applied $100.00 from payment on invoice #INV-NEW (open invoice)',
      paymentGroupId: groupId,
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-NEW',
      isDeleted: false,
    };
    const recordedOnlyTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 0,
      method: 'Check',
      note: 'Payment of $100.00 recorded; applied to prior outstanding invoices first',
      paymentGroupId: groupId,
      fifoAllocationRole: 'recorded_only',
      recordedPaymentTotal: 100,
      fifoRedirectedAmount: 100,
      isDeleted: false,
    };
    const olderInvoice = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-OLD',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [priorAllocationTx],
    });
    const newerInvoice = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-NEW',
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 100,
      status: INVOICE_STATUS.PENDING,
      paymentTransactions: [recordedOnlyTx],
    });

    Invoice.find = () => makeThenableQuery([olderInvoice, newerInvoice]);

    const result = await reverseRecordedPaymentGroup({
      invoice: newerInvoice,
      tx: recordedOnlyTx,
      userId,
    });

    assert.equal(result.reversalMode, 'payment_allocation');
    assert.equal(recordedOnlyTx.isDeleted, true);
    assert.equal(priorAllocationTx.isDeleted, true);
    assert.equal(olderInvoice.alreadyPaid, 0);
    assert.equal(olderInvoice.balanceDue, 100);
    assert.equal(olderInvoice.status, INVOICE_STATUS.PENDING);
    assert.equal(newerInvoice.alreadyPaid, 0);
    assert.equal(result.totalRemoved, 100);
    assert.equal(result.affectedInvoices.length, 2);
  });

  it('removing a linked prior allocation reverses the original recorded payment', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-fifo-remove-2`;
    const priorAllocationTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Applied $100.00 from payment on invoice #INV-NEW (open invoice)',
      paymentGroupId: groupId,
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-NEW',
      isDeleted: false,
    };
    const selfAllocationTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-NEW',
      paymentGroupId: groupId,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      fifoRedirectedAmount: 100,
      isDeleted: false,
    };
    const olderInvoice = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-OLD',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [priorAllocationTx],
    });
    const newerInvoice = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-NEW',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIALLY_PAID,
      paymentTransactions: [selfAllocationTx],
    });

    Invoice.find = () => makeThenableQuery([olderInvoice, newerInvoice]);

    const result = await reverseRecordedPaymentGroup({
      invoice: olderInvoice,
      tx: priorAllocationTx,
      userId,
    });

    assert.equal(result.reversalMode, 'payment_allocation');
    assert.equal(selfAllocationTx.isDeleted, true);
    assert.equal(priorAllocationTx.isDeleted, true);
    assert.equal(olderInvoice.alreadyPaid, 0);
    assert.equal(olderInvoice.balanceDue, 100);
    assert.equal(newerInvoice.alreadyPaid, 0);
    assert.equal(newerInvoice.balanceDue, 100);
    assert.equal(result.totalRemoved, 150);
  });

  it('preview includes prior allocation reversals for redirected payments', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-fifo-preview-1`;
    const priorAllocationTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Applied $100.00 from payment on invoice #INV-NEW (open invoice)',
      paymentGroupId: groupId,
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-NEW',
      isDeleted: false,
    };
    const recordedOnlyTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 0,
      method: 'Check',
      paymentGroupId: groupId,
      fifoAllocationRole: 'recorded_only',
      recordedPaymentTotal: 100,
      isDeleted: false,
    };
    const olderInvoice = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-OLD',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [priorAllocationTx],
    });
    const newerInvoice = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-NEW',
      subAmount: 100,
      alreadyPaid: 0,
      balanceDue: 100,
      status: INVOICE_STATUS.PENDING,
      paymentTransactions: [recordedOnlyTx],
    });

    Invoice.find = () => makeThenableQuery([olderInvoice, newerInvoice]);

    const preview = await previewRecordedPaymentReversal({
      invoice: newerInvoice,
      tx: recordedOnlyTx,
    });

    assert.equal(preview.reversalMode, 'payment_allocation');
    assert.equal(preview.originalPaymentTotal, 100);
    assert.equal(preview.priorAllocationAmount, 100);
    assert.equal(preview.priorAllocationReversals.length, 1);
    assert.equal(preview.priorAllocationReversals[0].invoiceNumber, 'INV-OLD');

    const linkedPreview = await previewRecordedPaymentReversal({
      invoice: olderInvoice,
      tx: priorAllocationTx,
    });

    assert.equal(linkedPreview.reversalMode, 'payment_allocation');
    assert.equal(linkedPreview.originalPaymentTotal, 100);
    assert.equal(linkedPreview.priorAllocationAmount, 100);
  });

  it('blocks independent delete preview for stamped downstream credit applications', async () => {
    const stampedTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: 'group-source-1',
      sourceInvoiceNumber: 'INV-A',
      isDeleted: false,
    };

    assert.equal(isDownstreamCreditApplication(stampedTx), true);

    const invoice = makeInvoiceDoc({
      invoiceId: 'INV-B',
      subAmount: 100,
      alreadyPaid: 50,
      balanceDue: 50,
      status: INVOICE_STATUS.PARTIAL,
      paymentTransactions: [stampedTx],
    });

    const result = await previewRecordedPaymentReversal({ invoice, tx: stampedTx });
    assert.equal(result.blocked, true);
    assert.equal(result.reversalMode, 'credit_applied_blocked');
    assert.match(String(result.message || ''), /INV-A/);

    const manualTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 25,
      method: 'Credit Adjustment',
      note: 'Credit manually applied to invoice · Applied $25.00 from available credit balance',
      isDeleted: false,
    };
    assert.equal(isDownstreamCreditApplication(manualTx), false);
  });

  it('removing a $210 payment reverses invoice B, downstream credit on invoice C, and remaining credit (scenario 8)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = `${new mongoose.Types.ObjectId()}-210`;
    const paymentTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-B',
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
    const creditAppliedTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $100.00 from available credit balance',
      sourcePaymentGroupId: groupId,
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
      paymentTransactions: [creditAppliedTx],
    });

    remainingCredit = 10;
    Invoice.find = () => makeThenableQuery([invoiceC]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoiceB,
      tx: paymentTx,
      userId,
    });

    assert.equal(result.reversalMode, 'payment_allocation');
    assert.equal(result.totalRemoved, 210);
    assert.equal(paymentTx.isDeleted, true);
    assert.equal(creditStoredTx.isDeleted, true);
    assert.equal(creditAppliedTx.isDeleted, true);
    assert.equal(invoiceB.alreadyPaid, 0);
    assert.equal(invoiceB.balanceDue, 100);
    assert.equal(invoiceC.alreadyPaid, 0);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(remainingCredit, 0);
  });

  it('removing a $550 payment reverses C/D/E allocations and $250 credit without touching Invoice A credit', async () => {
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
      note: 'Payment recorded for invoice #INV-B',
      isDeleted: false,
    };

    const priorAllocationC = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Applied $100.00 from payment on invoice #INV-D (overdue invoice)',
      paymentGroupId: group550,
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-D',
      isDeleted: false,
    };
    const priorAllocationE = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Applied $100.00 from payment on invoice #INV-D (overdue invoice)',
      paymentGroupId: group550,
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-D',
      isDeleted: false,
    };
    const paymentDTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-D',
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

    const invoiceA = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-A',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentATx, creditStoredATx],
    });
    const invoiceB = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-B',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [creditAppliedBFromA, paymentBTx],
    });
    const invoiceC = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-C',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2020-01-01'),
      paymentTransactions: [priorAllocationC],
    });
    const invoiceD = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-D',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentDTx, creditStoredDTx],
    });
    const invoiceE = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-E',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2020-01-01'),
      paymentTransactions: [priorAllocationE],
    });

    remainingCredit = 250;
    Invoice.find = () => makeThenableQuery([invoiceC, invoiceE, invoiceB]);

    const preview = await previewRecordedPaymentReversal({
      invoice: invoiceD,
      tx: paymentDTx,
    });

    assert.equal(preview.originalPaymentTotal, 550);
    assert.equal(preview.creditStoredAmount, 250);
    assert.equal(preview.unusedCreditAmount, 250);
    assert.equal(preview.priorAllocationAmount, 200);
    assert.equal(preview.priorAllocationReversals.length, 2);
    assert.deepEqual(preview.downstreamApplications, []);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoiceD,
      tx: paymentDTx,
      userId,
    });

    assert.equal(result.reversalMode, 'payment_allocation');
    assert.equal(result.totalRemoved, 550);
    assert.equal(paymentDTx.isDeleted, true);
    assert.equal(creditStoredDTx.isDeleted, true);
    assert.equal(priorAllocationC.isDeleted, true);
    assert.equal(priorAllocationE.isDeleted, true);
    assert.equal(creditAppliedBFromA.isDeleted, false);
    assert.equal(paymentBTx.isDeleted, false);
    assert.equal(invoiceC.alreadyPaid, 0);
    assert.equal(invoiceC.balanceDue, 100);
    assert.equal(invoiceC.status, INVOICE_STATUS.OVERDUE);
    assert.equal(invoiceD.alreadyPaid, 0);
    assert.equal(invoiceD.balanceDue, 100);
    assert.equal(invoiceE.alreadyPaid, 0);
    assert.equal(invoiceE.balanceDue, 100);
    assert.equal(invoiceE.status, INVOICE_STATUS.OVERDUE);
    assert.equal(invoiceB.alreadyPaid, 100);
    assert.equal(invoiceB.balanceDue, 0);
    assert.equal(remainingCredit, 0);
  });

  it('removing Payment 1 only reverses Payment 1\'s portion of a combined credit application (scenario 23)', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const group1 = `${new mongoose.Types.ObjectId()}-p1`;
    const group2 = `${new mongoose.Types.ObjectId()}-p2`;
    const payment1Tx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-A',
      paymentGroupId: group1,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 150,
      isDeleted: false,
    };
    const credit1Tx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Balance',
      note: 'Overpayment of $50.00 stored as credit balance',
      paymentGroupId: group1,
      isDeleted: false,
    };
    const payment2Tx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-B',
      paymentGroupId: group2,
      fifoAllocationRole: 'self_allocation',
      recordedPaymentTotal: 175,
      isDeleted: false,
    };
    const credit2Tx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 75,
      method: 'Credit Balance',
      note: 'Overpayment of $75.00 stored as credit balance',
      paymentGroupId: group2,
      isDeleted: false,
    };
    const creditFromP1 = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: group1,
      isDeleted: false,
    };
    const creditFromP2 = {
      _id: new mongoose.Types.ObjectId(),
      amount: 50,
      method: 'Credit Adjustment',
      note: 'Credit automatically applied to open invoice · Applied $50.00 from available credit balance',
      sourcePaymentGroupId: group2,
      isDeleted: false,
    };

    const invoiceA = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-A',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [payment1Tx, credit1Tx],
    });
    const invoiceB = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-B',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [payment2Tx, credit2Tx],
    });
    const invoiceC = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-C',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [creditFromP1, creditFromP2],
    });

    remainingCredit = 25;
    Invoice.find = () => makeThenableQuery([invoiceB, invoiceC]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoiceA,
      tx: payment1Tx,
      userId,
    });

    assert.equal(result.reversalMode, 'payment_allocation');
    assert.equal(payment1Tx.isDeleted, true);
    assert.equal(credit1Tx.isDeleted, true);
    assert.equal(creditFromP1.isDeleted, true);
    assert.equal(creditFromP2.isDeleted, false);
    assert.equal(payment2Tx.isDeleted, false);
    assert.equal(credit2Tx.isDeleted, false);
    assert.equal(invoiceC.alreadyPaid, 50);
    assert.equal(invoiceC.balanceDue, 50);
    assert.equal(remainingCredit, 25);
  });

  it('deleting Invoice A payment preserves D-pool credit for re-application after B–F chain (INV-SC-024)', async () => {
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

    const priorAllocationC = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Applied $100.00 from payment on invoice #INV-D (overdue invoice)',
      paymentGroupId: group550,
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-D',
      isDeleted: false,
    };
    const priorAllocationE = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Applied $100.00 from payment on invoice #INV-D (overdue invoice)',
      paymentGroupId: group550,
      fifoAllocationRole: 'prior_allocation',
      recordedAgainstInvoiceNumber: 'INV-D',
      isDeleted: false,
    };
    const paymentDTx = {
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      method: 'Check',
      note: 'Payment recorded for invoice #INV-D',
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
      paymentTransactions: [creditAppliedBFromA, paymentBTx],
    });
    const invoiceC = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-C',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2020-01-01'),
      paymentTransactions: [priorAllocationC],
    });
    const invoiceD = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-D',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [paymentDTx, creditStoredDTx],
    });
    const invoiceE = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-E',
      subAmount: 100,
      alreadyPaid: 100,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      dueDate: new Date('2020-01-01'),
      paymentTransactions: [priorAllocationE],
    });
    const invoiceF = makeInvoiceDoc({
      propertyId,
      invoiceId: 'INV-F',
      subAmount: 200,
      alreadyPaid: 200,
      balanceDue: 0,
      status: INVOICE_STATUS.PAID,
      paymentTransactions: [creditAppliedFFromD],
    });

    remainingCredit = 50;
    Invoice.find = () => makeThenableQuery([
      invoiceB,
      invoiceC,
      invoiceD,
      invoiceE,
      invoiceF,
    ]);

    const result = await reverseRecordedPaymentGroup({
      invoice: invoiceA,
      tx: paymentATx,
      userId,
    });

    assert.equal(result.reversalMode, 'payment_allocation');
    assert.equal(result.totalRemoved, 150);
    assert.equal(paymentATx.isDeleted, true);
    assert.equal(creditStoredATx.isDeleted, true);
    assert.equal(creditAppliedBFromA.isDeleted, true);
    assert.equal(paymentBTx.isDeleted, false);
    assert.equal(creditAppliedFFromD.isDeleted, false);
    assert.equal(priorAllocationC.isDeleted, false);
    assert.equal(priorAllocationE.isDeleted, false);
    assert.equal(paymentDTx.isDeleted, false);
    assert.equal(creditStoredDTx.isDeleted, false);

    assert.equal(invoiceA.alreadyPaid, 0);
    assert.equal(invoiceA.balanceDue, 100);
    assert.equal(invoiceA.status, INVOICE_STATUS.OVERDUE);

    assert.equal(invoiceB.alreadyPaid, 0);
    assert.equal(invoiceB.processingAmount, 50);
    assert.equal(invoiceB.balanceDue, 50);
    assert.equal(invoiceB.status, INVOICE_STATUS.PROCESSING);

    assert.equal(invoiceF.alreadyPaid, 200);
    assert.equal(invoiceF.balanceDue, 0);

    // D-pool credit ($50 after F consumed $200) must survive A reversal - not zeroed.
    assert.equal(remainingCredit, 50);

    // Service layer (deleteInvoicePayment) must call applyAllUnappliedCreditToDueInvoices
    // so the preserved D-pool credit auto-applies to Invoice A after reversal.
  });
});
