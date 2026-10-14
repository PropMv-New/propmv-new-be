const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Invoice = require('../../invoice/model/invoice.model');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { waiveOpenDueInvoicesForSettlement } = require('../services/ledger.service');

describe('owner removal waive settlement', () => {
  let originalInvoiceFind;

  beforeEach(() => {
    originalInvoiceFind = Invoice.find;
  });

  afterEach(() => {
    Invoice.find = originalInvoiceFind;
  });

  it('marks due invoices Waived with waivedAmount instead of Paid', async () => {
    const unitId = new mongoose.Types.ObjectId();
    const invoiceDoc = {
      _id: new mongoose.Types.ObjectId(),
      propertyId: unitId,
      status: INVOICE_STATUS.PENDING,
      dueDate: new Date('2026-06-01T12:00:00Z'),
      balanceDue: 200,
      alreadyPaid: 0,
      waivedAmount: 0,
      waiveHistory: [],
      save: async function save() {
        return this;
      },
    };

    Invoice.find = () => ({
      sort: () => Promise.resolve([invoiceDoc]),
    });

    const remaining = await waiveOpenDueInvoicesForSettlement(
      unitId,
      200,
      null,
      'Outstanding balance waived during owner removal',
      new mongoose.Types.ObjectId(),
      []
    );

    assert.equal(remaining, 0);
    assert.equal(invoiceDoc.status, INVOICE_STATUS.WAIVED);
    assert.equal(invoiceDoc.balanceDue, 0);
    assert.equal(invoiceDoc.waivedAmount, 200);
    assert.equal(invoiceDoc.alreadyPaid, 0);
    assert.equal(invoiceDoc.waiveHistory.length, 1);
    assert.equal(invoiceDoc.waiveHistory[0].amount, 200);
    assert.equal(invoiceDoc.waiveHistory[0].method, undefined);
  });

  it('backfills legacy invoice comments missing createdBy during owner-removal settlement', async () => {
    const unitId = new mongoose.Types.ObjectId();
    const performedBy = new mongoose.Types.ObjectId();
    const invoiceDoc = {
      _id: new mongoose.Types.ObjectId(),
      propertyId: unitId,
      status: INVOICE_STATUS.PENDING,
      dueDate: new Date('2026-06-01T12:00:00Z'),
      balanceDue: 75,
      alreadyPaid: 0,
      waivedAmount: 0,
      waiveHistory: [],
      comments: [{
        text: 'Automated payment reminder (due_today) sent to owner@example.com.',
        isSystem: true,
        createdAt: new Date('2026-05-01T12:00:00Z'),
        updatedAt: new Date('2026-05-01T12:00:00Z'),
      }],
      save: async function save() {
        return this;
      },
    };

    Invoice.find = () => ({
      sort: () => Promise.resolve([invoiceDoc]),
    });

    await waiveOpenDueInvoicesForSettlement(
      unitId,
      75,
      null,
      'Outstanding balance waived during owner removal',
      performedBy,
      []
    );

    assert.equal(String(invoiceDoc.comments[0].createdBy), String(performedBy));
    assert.equal(String(invoiceDoc.comments[0].updatedBy), String(performedBy));
  });
});
