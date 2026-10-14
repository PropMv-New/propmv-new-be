const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const servicePath = require.resolve('../portals/landlord/modules/invoice/service/invoice.service');
const invoiceModelPath = require.resolve('../portals/landlord/modules/invoice/model/invoice.model');
const propertyModelPath = require.resolve('../portals/landlord/modules/property/model/property.model');
const leaseModelPath = require.resolve('../portals/landlord/modules/leasing/model/lease.model');
const eventModelPath = require.resolve('../shared/modules/events/model/event.model');

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
});

test('landlord createInvoice preserves property and unit fields for payloads with leaseId and invoiceDetails', async () => {
  clearModule(servicePath);
  clearModule(invoiceModelPath);

  const Invoice = require(invoiceModelPath);
  const Property = require(propertyModelPath);
  const Lease = require(leaseModelPath);
  const Event = require(eventModelPath);

  const propertyId = '6a12acb30de850e661c823b4';
  const unitId = '6a12acb30de850e661c823b5';
  const leaseId = '6a12e56567ff38a0bb71188f';
  const tenantIds = ['6a12bfb96c5490a98e57d666', '69db8f2e328a2726e0ee4645'];
  let savedDoc = null;
  const createdEvents = [];

  patch(Property, 'findOne', (filter) => queryResult({
    _id: filter._id || propertyId,
    name: 'Test Property',
    createdBy: '507f1f77bcf86cd799439011',
    unitDetails: [{ _id: unitId, unitName: 'Unit 1' }],
  }));
  patch(Lease, 'findOne', (filter) => queryResult({
    _id: filter._id || leaseId,
    property_id: propertyId,
    unitId,
    unitName: 'Unit 1',
    leaseTerm: 'May 25, 2026 - May 27, 2026',
    rentAndDepositDestribution: {
      split: tenantIds.map((tenantId) => ({ tenantId })),
    },
  }));
  patch(Invoice, 'findOne', (filter) => {
    if (filter && filter._id && savedDoc && String(filter._id) === String(savedDoc._id)) {
      return queryResult(savedDoc);
    }
    return queryResult(null);
  });
  patch(Event, 'create', async (docs) => {
    const rows = Array.isArray(docs) ? docs : [docs];
    rows.forEach((row) => {
      assert.equal(String(row.propertyId), propertyId);
      assert.equal(row.unit, 'Unit 1');
    });
    createdEvents.push(...rows);
    return rows;
  });
  patch(Invoice.prototype, 'save', async function saveStub() {
    if (this.balanceDue === 0) {
      this.status = 'Paid';
    } else if (this.balanceDue === this.subAmount) {
      this.status = 'Pending';
    } else {
      this.status = 'Partially Paid';
    }
    if (!this._id) {
      this._id = '6b12acb30de850e661c823b5';
    }
    savedDoc = this;
    return this;
  });

  const service = require(servicePath);
  const result = await service.createInvoice({
    propertyId,
    unitId,
    unit: 'Unit 1',
    term: 'May 25, 2026 - May 27, 2026',
    tenants: tenantIds,
    isAllTenantSelected: false,
    subAmount: 100,
    alreadyPaid: 0,
    balanceDue: 100,
    notes: 'Notes',
    isRecurringInvoice: false,
    type: 'Rent',
    isPartialPaymentAllowed: false,
    invoiceItemDetails: [{
      invoiceItem: 'Test',
      description: 'Test',
      quantity: 1,
      rate: 100,
      amount: 100,
    }],
    invoiceId: 'INV346252',
    dueDate: '2026-05-25',
    leaseId,
    invoiceDetails: [{
      dueDate: '2026-05-25',
      amount: 100,
      description: 'Rent',
      scheduleKey: 'non-recurring-1',
      status: 'Pending',
      alreadyPaid: 0,
    }],
  }, '507f1f77bcf86cd799439011', [], { session: { fake: true } });

  assert.equal(String(result.propertyId), propertyId);
  assert.equal(String(result.unitId), unitId);
  assert.equal(result.unit, 'Unit 1');
  assert.equal(result.propertyName, 'Test Property');
  assert.equal(String(result.lease_id), leaseId);
  assert.equal(result.status, 'Pending');
  assert.equal(Array.isArray(result.comments), true);
  assert.equal(result.comments.length, 1);
  assert.equal(createdEvents.length, tenantIds.length);
});
