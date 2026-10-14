const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const {
  buildBoardMemberInviteRoleConflictError,
} = require('../service/hoa.service');

test('buildBoardMemberInviteRoleConflictError uses HOA Owner message', () => {
  const err = buildBoardMemberInviteRoleConflictError('HOA Owner');
  assert.equal(err.status, 409);
  assert.equal(
    err.message,
    'This user already has an HOA Owner account. You cannot send a Board Member invitation.'
  );
});

test('buildBoardMemberInviteRoleConflictError uses role-specific message', () => {
  const err = buildBoardMemberInviteRoleConflictError('Tenant');
  assert.equal(err.status, 409);
  assert.equal(
    err.message,
    'This user already has a Tenant account. You cannot send a Board Member invitation.'
  );
});

test('rollbackFailedInviteDelivery deletes brand-new memberships', async () => {
  const HOAMembership = require('../model/hoaMembership.model');
  const deleteOne = mock.method(HOAMembership, 'deleteOne', async () => ({ deletedCount: 1 }));
  const updateOne = mock.method(HOAMembership, 'updateOne', async () => ({ matchedCount: 0 }));

  const { rollbackFailedInviteDelivery } = require('../service/hoa.service');
  await rollbackFailedInviteDelivery('membership-new', null);

  assert.equal(deleteOne.mock.callCount(), 1);
  assert.equal(updateOne.mock.callCount(), 0);
  assert.deepEqual(deleteOne.mock.calls[0].arguments[0], { _id: 'membership-new' });

  deleteOne.mock.restore();
  updateOne.mock.restore();
});

test('rollbackFailedInviteDelivery restores prior pending invite snapshot', async () => {
  const HOAMembership = require('../model/hoaMembership.model');
  const deleteOne = mock.method(HOAMembership, 'deleteOne', async () => ({ deletedCount: 0 }));
  const updateOne = mock.method(HOAMembership, 'updateOne', async () => ({ matchedCount: 1 }));

  const { rollbackFailedInviteDelivery } = require('../service/hoa.service');
  const prior = {
    status: 'pending',
    invitedBy: 'admin-1',
    role: 'member',
    userId: null,
    inviteToken: 'old-token',
    inviteTokenExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
  };

  await rollbackFailedInviteDelivery('membership-pending', prior);

  assert.equal(deleteOne.mock.callCount(), 0);
  assert.equal(updateOne.mock.callCount(), 1);
  assert.deepEqual(updateOne.mock.calls[0].arguments[0], { _id: 'membership-pending' });
  assert.deepEqual(updateOne.mock.calls[0].arguments[1], {
    $set: {
      status: 'pending',
      invitedBy: 'admin-1',
      role: 'member',
      inviteToken: 'old-token',
      inviteTokenExpiresAt: prior.inviteTokenExpiresAt,
    },
  });

  deleteOne.mock.restore();
  updateOne.mock.restore();
});

test('rollbackFailedInviteDelivery restores revoked membership without token', async () => {
  const HOAMembership = require('../model/hoaMembership.model');
  const deleteOne = mock.method(HOAMembership, 'deleteOne', async () => ({ deletedCount: 0 }));
  const updateOne = mock.method(HOAMembership, 'updateOne', async () => ({ matchedCount: 1 }));

  const { rollbackFailedInviteDelivery } = require('../service/hoa.service');
  const prior = {
    status: 'revoked',
    invitedBy: 'admin-1',
    role: 'member',
    userId: 'user-1',
    inviteToken: null,
    inviteTokenExpiresAt: null,
  };

  await rollbackFailedInviteDelivery('membership-revoked', prior);

  assert.equal(deleteOne.mock.callCount(), 0);
  assert.equal(updateOne.mock.callCount(), 1);
  assert.deepEqual(updateOne.mock.calls[0].arguments[1], {
    $set: {
      status: 'revoked',
      invitedBy: 'admin-1',
      role: 'member',
      userId: 'user-1',
    },
    $unset: { inviteToken: '', inviteTokenExpiresAt: '' },
  });

  deleteOne.mock.restore();
  updateOne.mock.restore();
});
