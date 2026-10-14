const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  maintenanceRequestedByUserIds,
  userCanParticipateInMaintenanceComments,
} = require('./maintenanceCommentAccess');

describe('maintenanceRequestedByUserIds', () => {
  it('normalizes scalar and array requestedBy values', () => {
    assert.deepEqual(
      maintenanceRequestedByUserIds({ requestedBy: ['64b1f1f1f1f1f1f1f1f1f1f1'] }),
      ['64b1f1f1f1f1f1f1f1f1f1f1']
    );
    assert.deepEqual(
      maintenanceRequestedByUserIds({
        requestedBy: [{ _id: '64b1f1f1f1f1f1f1f1f1f1f2' }],
      }),
      ['64b1f1f1f1f1f1f1f1f1f1f2']
    );
  });
});

describe('userCanParticipateInMaintenanceComments', () => {
  it('allows requesters without property lookup', async () => {
    const allowed = await userCanParticipateInMaintenanceComments(
      { requestedBy: ['64b1f1f1f1f1f1f1f1f1f1f9'] },
      '64b1f1f1f1f1f1f1f1f1f1f9'
    );
    assert.equal(allowed, true);
  });

  it('rejects missing user id', async () => {
    const allowed = await userCanParticipateInMaintenanceComments(
      { requestedBy: ['64b1f1f1f1f1f1f1f1f1f1f1'] },
      null
    );
    assert.equal(allowed, false);
  });

  it('allows HOA board members for tickets in their community via userContext', async () => {
    const allowed = await userCanParticipateInMaintenanceComments(
      {
        hoaId: '64b1f1f1f1f1f1f1f1f1f1a1',
        requestedBy: ['64b1f1f1f1f1f1f1f1f1f1b1'],
      },
      '64b1f1f1f1f1f1f1f1f1f1c1',
      { isHOABoardMember: true, hoaId: '64b1f1f1f1f1f1f1f1f1f1a1' }
    );
    assert.equal(allowed, true);
  });
});
