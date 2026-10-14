const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const servicePath = require.resolve('../portals/landlord/modules/invoice/service/invoice.service');
const invoiceModelPath = require.resolve('../portals/landlord/modules/invoice/model/invoice.model');
const propertyModelPath = require.resolve('../portals/landlord/modules/property/model/property.model');
const validatorPath = require.resolve('../portals/landlord/modules/invoice/validators/invoice.validator');

const restoreFns = [];

const clearModule = (modulePath) => {
  delete require.cache[modulePath];
};

const patch = (target, key, value) => {
  const original = target[key];
  restoreFns.push(() => {
    target[key] = original;
  });
  target[key] = value;
};

const queryResult = (result) => ({
  select() { return this; },
  session() { return this; },
  populate() { return this; },
  lean() { return Promise.resolve(result); },
  then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  catch(reject) { return Promise.resolve(result).catch(reject); },
});

afterEach(() => {
  while (restoreFns.length > 0) {
    const restore = restoreFns.pop();
    restore();
  }
  clearModule(servicePath);
  clearModule(invoiceModelPath);
  clearModule(validatorPath);
});

test('landlord updateInvoiceSchema accepts payment recording fields used by the UI', () => {
  clearModule(validatorPath);
  const { updateInvoiceSchema } = require(validatorPath);

  const payload = {
    alreadyPaid: 100,
    balanceDue: 0,
    paidOn: '2026-05-25',
    paymentMethod: 'Check',
    paymentType: 'Check',
    paymentUserId: '6a12bfb96c5490a98e57d666',
    checkNumber: 'CHK-1001',
    paymentNotes: 'Paid in office',
    documentToDelete: ['6f12acb30de850e661c823b7'],
  };

  const { error } = updateInvoiceSchema.validate(payload, {
    abortEarly: false,
    allowUnknown: false,
  });

  assert.equal(error, undefined);
});

test('landlord updateInvoice records payment from paymentMethod alias and detaches requested documents', async () => {
  clearModule(servicePath);
  clearModule(invoiceModelPath);

  const Invoice = require(invoiceModelPath);
  const Property = require(propertyModelPath);

  const invoiceId = '6a147194a79823bfd3ce9f13';
  const propertyId = '6a12acb30de850e661c823b4';
  const unitId = '6a12acb30de850e661c823b5';
  const tenantId = '6a12bfb96c5490a98e57d666';
  const keepDocId = '6f12acb30de850e661c823b8';
  const removeDocId = '6f12acb30de850e661c823b7';

  const currentInvoice = new Invoice({
    _id: invoiceId,
    invoiceId: 'INV244649',
    type: 'Rent',
    propertyId,
    propertyName: 'Test Property',
    unitId,
    unit: 'Unit 1',
    term: 'May 25, 2026 - May 27, 2026',
    tenants: [tenantId],
    invoiceItemDetails: [{
      invoiceItem: 'Internet',
      description: 'Internet',
      quantity: 1,
      rate: 100,
      amount: 100,
    }],
    subAmount: 100,
    alreadyPaid: 0,
    balanceDue: 100,
    isPartialPaymentAllowed: false,
    dueDate: new Date('2026-05-25T00:00:00.000Z'),
    createdBy: '507f1f77bcf86cd799439011',
    documents: [
      { metadataId: removeDocId, originalName: 'remove.pdf' },
      { metadataId: keepDocId, originalName: 'keep.pdf' },
    ],
  });

  patch(Property, 'findOne', (filter) => queryResult({
    _id: filter._id || propertyId,
    name: 'Test Property',
    unitDetails: [{ _id: unitId, unitName: 'Unit 1' }],
  }));

  let savedDoc = currentInvoice;
  patch(Invoice, 'findOne', (filter) => {
    if (filter && filter._id && String(filter._id) === String(invoiceId)) {
      return queryResult(savedDoc);
    }
    return queryResult(null);
  });

  patch(Invoice.prototype, 'save', async function saveStub() {
    if (this.balanceDue === 0) {
      this.status = 'Paid';
    } else if (this.balanceDue === this.subAmount) {
      this.status = 'Pending';
    } else {
      this.status = 'Partially Paid';
    }
    savedDoc = this;
    return this;
  });

  const service = require(servicePath);
  const result = await service.updateInvoice(
    invoiceId,
    {
      alreadyPaid: 100,
      balanceDue: 0,
      paidOn: '2026-05-25',
      paymentMethod: 'Check',
      paymentUserId: tenantId,
      checkNumber: 'CHK-1001',
      paymentNotes: 'Paid in office',
      documentToDelete: [removeDocId],
    },
    '507f1f77bcf86cd799439011',
    [],
    { session: { fake: true } }
  );

  assert.equal(result.alreadyPaid, 100);
  assert.equal(result.balanceDue, 0);
  assert.equal(result.paymentHistory.length, 1);
  assert.equal(result.paymentHistory[0].paymentType, 'Check');
  assert.equal(result.paymentHistory[0].checkNumber, 'CHK-1001');
  assert.equal(result.paymentHistory[0].notes, 'Paid in office');
  assert.equal(result.documents.length, 1);
  assert.equal(String(result.documents[0].metadataId), keepDocId);
});

test('landlord updateInvoice rejects partial payment when isPartialPaymentAllowed is false', async () => {
  clearModule(servicePath);
  clearModule(invoiceModelPath);

  const Invoice = require(invoiceModelPath);
  const Property = require(propertyModelPath);

  const invoiceId = '6a147194a79823bfd3ce9f14';
  const propertyId = '6a12acb30de850e661c823b4';
  const unitId = '6a12acb30de850e661c823b5';
  const tenantId = '6a12bfb96c5490a98e57d666';

  const currentInvoice = new Invoice({
    _id: invoiceId,
    invoiceId: 'INV244650',
    type: 'Rent',
    propertyId,
    propertyName: 'Test Property',
    unitId,
    unit: 'Unit 1',
    term: 'May 25, 2026 - May 27, 2026',
    tenants: [tenantId],
    invoiceItemDetails: [{
      invoiceItem: 'Rent',
      description: 'Rent',
      quantity: 1,
      rate: 100,
      amount: 100,
    }],
    subAmount: 100,
    alreadyPaid: 0,
    balanceDue: 100,
    isPartialPaymentAllowed: false,
    dueDate: new Date('2026-05-25T00:00:00.000Z'),
    createdBy: '507f1f77bcf86cd799439011',
    documents: [],
  });

  patch(Property, 'findOne', (filter) => queryResult({
    _id: filter._id || propertyId,
    name: 'Test Property',
    unitDetails: [{ _id: unitId, unitName: 'Unit 1' }],
  }));

  patch(Invoice, 'findOne', (filter) => {
    if (filter && filter._id && String(filter._id) === String(invoiceId)) {
      return queryResult(currentInvoice);
    }
    return queryResult(null);
  });

  const service = require(servicePath);

  await assert.rejects(
    () => service.updateInvoice(
      invoiceId,
      {
        paymentAmount: 50,
        paidOn: '2026-05-25',
        paymentMethod: 'Check',
        paymentUserId: tenantId,
      },
      '507f1f77bcf86cd799439011',
      [],
      { session: { fake: true } }
    ),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Partial payments are not allowed/i);
      return true;
    }
  );
});
