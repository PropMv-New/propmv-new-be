const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectVendorMaintenanceContactIds,
  buildContactsOptionsFromRequest,
  wantsVendorEmailCommunityContacts,
} = require('./contacts.service');

describe('collectVendorMaintenanceContactIds', () => {
  it('includes only ticket creator and requesters for the vendor', () => {
    const ids = collectVendorMaintenanceContactIds({
      vendorUserId: 'vendor-1',
      ticket: {
        createdBy: 'creator-1',
        requestedBy: ['requester-1', 'owner-a'],
      },
    });

    assert.deepEqual([...ids].sort(), [
      'creator-1',
      'owner-a',
      'requester-1',
    ]);
  });

  it('excludes the vendor and ignores empty ticket parties', () => {
    const ids = collectVendorMaintenanceContactIds({
      vendorUserId: 'vendor-1',
      ticket: { createdBy: 'vendor-1', requestedBy: [] },
    });

    assert.deepEqual([...ids], []);
  });

  it('does not include board members or property owners who are not ticket parties', () => {
    const ids = collectVendorMaintenanceContactIds({
      vendorUserId: 'vendor-1',
      // Legacy args must be ignored if callers still pass them.
      boardMemberIds: ['board-1', 'board-2'],
      property: { associatedOwnerIds: ['owner-b', 'owner-c'] },
      ticket: {
        createdBy: 'creator-1',
        requestedBy: 'requester-1',
      },
    });

    assert.deepEqual([...ids].sort(), ['creator-1', 'requester-1']);
  });
});

describe('buildContactsOptionsFromRequest', () => {
  it('prefers hoaContext.hoaId over header for scoped contacts', () => {
    const options = buildContactsOptionsFromRequest({
      hoaContext: { hoaId: 'hoa-from-context', associatedHoaIds: ['hoa-a'] },
      headers: { 'x-hoa-id': 'hoa-from-header' },
      query: {},
      userRoleName: 'Vendor',
    });
    assert.equal(options.hoaId, 'hoa-from-context');
    assert.equal(options.isHOA, true);
    assert.equal(options.roleName, 'Vendor');
  });

  it('falls back to associatedHoaIds when vendor hoaContext.hoaId is unset', () => {
    const options = buildContactsOptionsFromRequest({
      hoaContext: { hoaId: null, associatedHoaIds: ['hoa-assoc-1', 'hoa-assoc-2'], isVendor: true },
      headers: {},
      query: {},
      userRoleName: 'Vendor',
    });
    assert.equal(options.hoaId, 'hoa-assoc-1');
    assert.equal(options.isHOA, true);
  });

  it('forwards maintenanceRequestId for ticket-scoped vendor contacts', () => {
    const options = buildContactsOptionsFromRequest({
      hoaContext: { hoaId: 'hoa-1' },
      headers: {},
      query: { maintenanceRequestId: 'ticket-99' },
    });
    assert.equal(options.maintenanceRequestId, 'ticket-99');
  });

  it('accepts maintenanceRequestId from request body for send/upload', () => {
    const options = buildContactsOptionsFromRequest({
      hoaContext: { hoaId: 'hoa-1' },
      headers: {},
      query: {},
      body: { maintenanceRequestId: 'ticket-body-1' },
    });
    assert.equal(options.maintenanceRequestId, 'ticket-body-1');
  });

  it('forwards contactPurpose for email compose community contacts', () => {
    const options = buildContactsOptionsFromRequest(
      {
        hoaContext: { hoaId: 'hoa-1' },
        headers: {},
        query: {},
        userRoleName: 'Vendor',
      },
      { contactPurpose: 'email' }
    );
    assert.equal(options.contactPurpose, 'email');
    assert.equal(options.roleName, 'Vendor');
  });
});

describe('wantsVendorEmailCommunityContacts', () => {
  it('is true only for email contact purpose', () => {
    assert.equal(wantsVendorEmailCommunityContacts({ contactPurpose: 'email' }), true);
    assert.equal(wantsVendorEmailCommunityContacts({ contactPurpose: 'EMAIL' }), true);
    assert.equal(wantsVendorEmailCommunityContacts({}), false);
    assert.equal(wantsVendorEmailCommunityContacts({ contactPurpose: 'messaging' }), false);
  });
});
