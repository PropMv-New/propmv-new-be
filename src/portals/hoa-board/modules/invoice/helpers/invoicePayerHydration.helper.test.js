const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isNamedPayer,
  currentOwnerIdsFromProperty,
  applyHydratedPayers,
} = require('./invoicePayerHydration.helper');

const OWNER_A = '6aa662808fe94f58b5e91e64';
const OWNER_B = '6aa662808fe94f58b5e91e65';

describe('isNamedPayer', () => {
  it('accepts a populated owner with a first name', () => {
    assert.equal(isNamedPayer({ _id: OWNER_A, firstName: 'Jordan', lastName: 'Lee' }), true);
  });

  it('rejects unpopulated ids and empty name objects', () => {
    assert.equal(isNamedPayer(OWNER_A), false);
    assert.equal(isNamedPayer({ _id: OWNER_A }), false);
    assert.equal(isNamedPayer({ email: 'N/A' }), false);
  });
});

describe('currentOwnerIdsFromProperty', () => {
  it('prefers active ownership-timeline owners', () => {
    const ids = currentOwnerIdsFromProperty({
      associatedOwnerIds: [OWNER_B],
      ownershipRecords: [
        { ownerId: OWNER_A, startDate: new Date('2020-01-01'), endDate: null },
        { ownerId: OWNER_B, startDate: new Date('2018-01-01'), endDate: new Date('2020-01-01') },
      ],
    });
    assert.deepEqual(ids, [OWNER_A]);
  });

  it('falls back to associatedOwnerIds when the timeline has no active row', () => {
    const ids = currentOwnerIdsFromProperty({
      associatedOwnerIds: [OWNER_A, OWNER_B],
      ownershipRecords: [],
    });
    assert.deepEqual(ids, [OWNER_A, OWNER_B]);
  });
});

describe('applyHydratedPayers', () => {
  const jordan = { _id: OWNER_A, firstName: 'Jordan', lastName: 'Lee', email: 'jordan@example.com' };

  it('replaces unpopulated tenant ids with the matching user', () => {
    const invoice = { tenants: [OWNER_A], propertyId: { associatedOwnerIds: [OWNER_A] } };
    applyHydratedPayers(invoice, new Map([[OWNER_A, jordan]]));
    assert.equal(invoice.tenants.length, 1);
    assert.equal(invoice.tenants[0].firstName, 'Jordan');
  });

  it('uses current unit owners when invoice tenants are empty', () => {
    const invoice = { tenants: [], propertyId: { associatedOwnerIds: [OWNER_A] } };
    applyHydratedPayers(invoice, new Map([[OWNER_A, jordan]]));
    assert.equal(invoice.tenants[0]._id, OWNER_A);
    assert.equal(invoice.tenants[0].lastName, 'Lee');
  });

  it('keeps already-populated tenants', () => {
    const invoice = { tenants: [jordan], propertyId: { associatedOwnerIds: [OWNER_B] } };
    applyHydratedPayers(invoice, new Map([[OWNER_A, jordan]]));
    assert.equal(invoice.tenants.length, 1);
    assert.equal(invoice.tenants[0].firstName, 'Jordan');
  });
});
