const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyOwnershipLogRevertToRecords,
  getOwnershipRevertBlockReason,
  getActiveOwnerIdsFromRecords,
  toDateAtStartOfDay,
} = require('../services/unit.service');

describe('ownership event revert helpers', () => {
  const ownerA = '6a77038d58c4a71f29801ede';
  const ownerB = '6a7ae99a630e813ee633f348';
  const effectiveDate = toDateAtStartOfDay('2026-09-05');

  it('reverts a REMOVE log by clearing the owner end date', () => {
    const records = [
      {
        ownerId: ownerA,
        startDate: new Date('2026-03-01T12:00:00.000Z'),
        endDate: effectiveDate,
      },
    ];

    const reverted = applyOwnershipLogRevertToRecords(records, {
      action: 'REMOVE',
      ownerIds: [ownerA],
      effectiveDate,
    });

    assert.equal(reverted[0].endDate, null);
    assert.deepEqual(
      getActiveOwnerIdsFromRecords(reverted, new Date('2026-08-29T15:00:00.000Z')),
      [ownerA],
    );
  });

  it('reverts an ADD log by removing the matching ownership record', () => {
    const records = [
      {
        ownerId: ownerA,
        startDate: new Date('2026-03-01T12:00:00.000Z'),
        endDate: null,
      },
      {
        ownerId: ownerB,
        startDate: effectiveDate,
        endDate: null,
      },
    ];

    const reverted = applyOwnershipLogRevertToRecords(records, {
      action: 'ADD',
      ownerIds: [ownerB],
      effectiveDate,
    });

    assert.equal(reverted.length, 1);
    assert.equal(reverted[0].ownerId, ownerA);
  });

  it('blocks revert for last-owner removal on an ownerless unit', () => {
    const pastRemovalDate = toDateAtStartOfDay('2026-08-01');
    const unit = {
      associatedOwnerIds: [],
      ownershipRecords: [
        {
          ownerId: ownerA,
          startDate: new Date('2026-03-01T12:00:00.000Z'),
          endDate: pastRemovalDate,
        },
      ],
      ownershipLogs: [
        {
          _id: 'log-remove',
          action: 'REMOVE',
          ownerIds: [ownerA],
          effectiveDate: pastRemovalDate,
        },
      ],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };

    const reason = getOwnershipRevertBlockReason(unit, unit.ownershipLogs[0]);
    assert.match(reason, /Last-owner removal/i);
  });

  it('blocks revert for change-of-ownership with balance reset', () => {
    const unit = {
      associatedOwnerIds: [ownerB],
      ownershipRecords: [],
      ownershipLogs: [],
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
    };

    const reason = getOwnershipRevertBlockReason(unit, {
      action: 'CHANGE',
      details: { balanceHandling: 'RESET' },
    });
    assert.match(reason, /reset balances/i);
  });
});
