const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const { filterInvoiceTenantsToCurrentOwners } = require('./invoiceOpenPayers.helper');

const ownerA = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', firstName: 'Ann', lastName: 'Able' };
const ownerB = { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', firstName: 'Ben', lastName: 'Baker' };
const removed = { _id: 'cccccccccccccccccccccccc', firstName: 'Cam', lastName: 'Closed' };

describe('filterInvoiceTenantsToCurrentOwners', () => {
  it('drops removed co-owners from overdue invoices', () => {
    const filtered = filterInvoiceTenantsToCurrentOwners({
      status: INVOICE_STATUS.OVERDUE,
      balanceDue: 120,
      tenants: [ownerA, removed, ownerB],
      propertyId: { associatedOwnerIds: [ownerA._id, ownerB._id] },
    });
    assert.deepEqual(
      filtered.map((t) => String(t._id)),
      [ownerA._id, ownerB._id]
    );
  });

  it('drops removed co-owners from partially paid invoices', () => {
    const filtered = filterInvoiceTenantsToCurrentOwners({
      status: INVOICE_STATUS.PARTIALLY_PAID,
      balanceDue: 40,
      tenants: [removed, ownerA],
      propertyId: { associatedOwnerIds: [ownerA._id, ownerB._id] },
    });
    assert.deepEqual(
      filtered.map((t) => String(t._id)),
      [ownerA._id]
    );
  });

  it('keeps historical payers on paid invoices', () => {
    const tenants = [removed, ownerA];
    const filtered = filterInvoiceTenantsToCurrentOwners({
      status: INVOICE_STATUS.PAID,
      balanceDue: 0,
      tenants,
      propertyId: { associatedOwnerIds: [ownerA._id, ownerB._id] },
    });
    assert.equal(filtered, tenants);
  });

  it('keeps historical payers while a payment is processing', () => {
    const tenants = [removed];
    const filtered = filterInvoiceTenantsToCurrentOwners({
      status: INVOICE_STATUS.OVERDUE,
      processingAmount: 50,
      balanceDue: 50,
      tenants,
      propertyId: { associatedOwnerIds: [ownerA._id] },
    });
    assert.equal(filtered, tenants);
  });

  it('leaves tenants unchanged when the unit has no current owners', () => {
    const tenants = [removed];
    const filtered = filterInvoiceTenantsToCurrentOwners({
      status: INVOICE_STATUS.OVERDUE,
      balanceDue: 10,
      tenants,
      propertyId: { associatedOwnerIds: [] },
    });
    assert.equal(filtered, tenants);
  });
});
