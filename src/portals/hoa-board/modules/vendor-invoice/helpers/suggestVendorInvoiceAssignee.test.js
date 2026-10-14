const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectTicketPartyIds,
  userTypeFromRoleName,
  suggestVendorInvoiceAssigneeId,
} = require('./suggestVendorInvoiceAssignee');

describe('suggestVendorInvoiceAssignee', () => {
  const board = { id: 'board-1', userType: 'board_member' };
  const owner = { id: 'owner-1', userType: 'owner' };
  const tenant = { id: 'tenant-1', userType: 'tenant' };

  it('maps HOA roles to assign-to party types', () => {
    assert.equal(userTypeFromRoleName('HOA Board Member'), 'board_member');
    assert.equal(userTypeFromRoleName('HOA Owner'), 'owner');
    assert.equal(userTypeFromRoleName('Tenant'), 'tenant');
    assert.equal(userTypeFromRoleName('Landlord'), 'landlord');
    assert.equal(userTypeFromRoleName('Property Manager'), 'property_manager');
  });

  it('prefers the ticket requester when they are assignable', () => {
    const suggested = suggestVendorInvoiceAssigneeId(
      [board, owner, tenant],
      { requestedBy: ['owner-1'], createdBy: 'board-1', createdByRole: 'HOA Board Member' }
    );
    assert.equal(suggested, 'owner-1');
  });

  it('falls back to the creator when no requester is in the list', () => {
    const suggested = suggestVendorInvoiceAssigneeId(
      [board, owner],
      { requestedBy: ['missing-user'], createdBy: 'board-1', createdByRole: 'HOA Board Member' }
    );
    assert.equal(suggested, 'board-1');
  });

  it('falls back to a matching party type from createdByRole', () => {
    const suggested = suggestVendorInvoiceAssigneeId(
      [board, owner],
      { createdByRole: 'HOA Owner' }
    );
    assert.equal(suggested, 'owner-1');
  });

  it('collects creator and requestedBy ids', () => {
    assert.deepEqual(
      collectTicketPartyIds({
        createdBy: { _id: 'board-1' },
        requestedBy: [{ _id: 'owner-1' }, 'tenant-1'],
      }),
      ['owner-1', 'tenant-1', 'board-1']
    );
  });
});
