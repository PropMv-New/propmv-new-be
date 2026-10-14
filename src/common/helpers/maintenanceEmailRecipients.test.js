const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUserId,
  normalizeRequestedByUserIds,
  shouldEmailMaintenanceRecipient,
  buildCreatedPartyNotifications,
} = require('./maintenanceEmailRecipients');

describe('normalizeRequestedByUserIds', () => {
  it('normalizes scalar and array requestedBy values', () => {
    const ownerId = '507f1f77bcf86cd799439011';
    const boardId = '507f1f77bcf86cd799439012';
    assert.deepEqual(normalizeRequestedByUserIds(ownerId), [ownerId]);
    assert.deepEqual(normalizeRequestedByUserIds([ownerId, boardId, ownerId]), [ownerId, boardId]);
  });
});

describe('normalizeUserId', () => {
  it('extracts _id from populated user references', () => {
    const vendorId = '507f1f77bcf86cd799439011';
    assert.equal(normalizeUserId({ _id: vendorId, firstName: 'Jane' }), vendorId);
    assert.equal(normalizeUserId(vendorId), vendorId);
  });
});

describe('shouldEmailMaintenanceRecipient', () => {
  const requesterId = '507f1f77bcf86cd799439011';
  const otherUserId = '507f1f77bcf86cd799439012';

  it('suppresses requester emails when Notify Requester is disabled', () => {
    const request = { notifyTenant: false, requestedBy: [requesterId] };
    assert.equal(shouldEmailMaintenanceRecipient(request, requesterId), false);
    assert.equal(shouldEmailMaintenanceRecipient(request, otherUserId), true);
  });

  it('allows requester emails when Notify Requester is enabled', () => {
    const request = { notifyTenant: true, requestedBy: [requesterId] };
    assert.equal(shouldEmailMaintenanceRecipient(request, requesterId), true);
  });
});

describe('filterMaintenanceNotifyUserIds', () => {
  const requesterId = '507f1f77bcf86cd799439011';
  const boardId = '507f1f77bcf86cd799439012';
  const ownerId = '507f1f77bcf86cd799439013';
  const { filterMaintenanceNotifyUserIds } = require('./maintenanceEmailRecipients');

  it('keeps requesters when Notify Requester is enabled', () => {
    const request = { notifyTenant: true, requestedBy: [requesterId, ownerId] };
    assert.deepEqual(
      filterMaintenanceNotifyUserIds(request, [boardId, requesterId, ownerId]).sort(),
      [boardId, requesterId, ownerId].sort()
    );
  });

  it('drops requesters when Notify Requester is disabled even if they are also board/owners', () => {
    const request = { notifyTenant: false, requestedBy: [requesterId, ownerId] };
    assert.deepEqual(
      filterMaintenanceNotifyUserIds(request, [boardId, requesterId, ownerId, boardId]),
      [boardId]
    );
  });
});

describe('buildCreatedPartyNotifications', () => {
  const creatorId = '507f1f77bcf86cd799439011';
  const requestedById = '507f1f77bcf86cd799439012';

  it('sends one combined notification when creator equals requestedBy', () => {
    const rows = buildCreatedPartyNotifications({
      creatorId,
      requestedByIds: [creatorId],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, creatorId);
    assert.equal(rows[0].eventKeyPrefix, 'maintenance_created');
  });

  it('sends separate creator and requestedBy notifications', () => {
    const rows = buildCreatedPartyNotifications({
      creatorId,
      requestedByIds: [requestedById],
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.eventKeyPrefix),
      ['maintenance_created_creator', 'maintenance_created_requested_by']
    );
  });

  it('uses on-behalf messaging for requestedBy recipient', () => {
    const rows = buildCreatedPartyNotifications({
      creatorId,
      requestedByIds: [requestedById],
      createdByDisplay: 'John Smith (HOA Board Member)',
      requestedForDisplay: 'Annu Bharti (HOA Owner)',
      isSelfCreated: false,
    });
    const requestedRow = rows.find((row) => row.userId === requestedById);
    assert.match(
      requestedRow.eventMessage,
      /John Smith \(HOA Board Member\) created a maintenance ticket on your behalf/
    );
  });

  it('deduplicates recipient ids while preserving both roles when same user listed twice', () => {
    const rows = buildCreatedPartyNotifications({
      creatorId,
      requestedByIds: [requestedById, requestedById],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.userId === requestedById).length, 1);
  });
});

describe('normalizeUserId', () => {
  it('accepts populated user objects and raw ids', () => {
    const id = '507f1f77bcf86cd799439011';
    assert.equal(normalizeUserId({ _id: id }), id);
    assert.equal(normalizeUserId(id), id);
    assert.equal(normalizeUserId('invalid'), null);
  });
});
