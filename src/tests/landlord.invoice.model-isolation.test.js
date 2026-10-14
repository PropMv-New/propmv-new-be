const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const landlordInvoiceModelPath = require.resolve('../portals/landlord/modules/invoice/model/invoice.model');

const removeModelIfPresent = (name) => {
  if (mongoose.models[name]) {
    mongoose.deleteModel(name);
  }
};

const resetModelState = () => {
  delete require.cache[landlordInvoiceModelPath];
  removeModelIfPresent('Invoice');
  removeModelIfPresent('LandlordInvoice');
};

afterEach(() => {
  resetModelState();
});

test('landlord invoice model uses its own schema even when a generic Invoice model already exists', () => {
  resetModelState();

  const conflictingSchema = new mongoose.Schema({
    propertyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    unit: { type: String, required: true },
  });
  mongoose.model('Invoice', conflictingSchema);

  const LandlordInvoice = require('../portals/landlord/modules/invoice/model/invoice.model');

  assert.equal(LandlordInvoice.modelName, 'LandlordInvoice');
  assert.equal(LandlordInvoice.collection.collectionName, 'invoices');
  assert.equal(mongoose.models.Invoice.collection.collectionName, 'invoices');
  assert.notEqual(LandlordInvoice.schema.path('unit').isRequired, true);
  assert.equal(LandlordInvoice.schema.path('propertyName').defaultValue, '');

  const validationError = new LandlordInvoice({
    invoiceId: 'INV100001',
    type: 'Rent',
    propertyId: new mongoose.Types.ObjectId(),
    term: 'May 25, 2026 - May 27, 2026',
    tenants: [new mongoose.Types.ObjectId()],
    invoiceItemDetails: [{
      invoiceItem: 'Test',
      description: 'Test',
      quantity: 1,
      rate: 100,
      amount: 100,
    }],
    subAmount: 100,
    alreadyPaid: 0,
    balanceDue: 100,
    isPartialPaymentAllowed: false,
    dueDate: new Date('2026-05-25T00:00:00.000Z'),
  }).validateSync();

  assert.equal(validationError?.errors?.unit, undefined);
  assert.equal(validationError?.errors?.propertyName, undefined);
});
