const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EVENTS = require('../notifications/notificationEvents');
const { dedupeIds } = require('./hoaRecipientResolver');

describe('hoa community notification events', () => {
  it('formats HOA fee update copy for board members', () => {
    assert.equal(
      EVENTS.HOA_FEE_UPDATED.message({ hoaName: 'Riverside' }),
      'HOA fee settings have been updated for Riverside.'
    );
    assert.equal(
      EVENTS.HOA_FEE_UPDATED.message({ customMessage: 'HOA fee amount is now $150.00.' }),
      'HOA fee amount is now $150.00.'
    );
  });

  it('formats board member update, delete, invited, and invite-accepted copy', () => {
    assert.equal(
      EVENTS.BOARD_MEMBER_UPDATED.message({ memberName: 'Pat Lee' }),
      'Board member "Pat Lee" has been updated.'
    );
    assert.equal(
      EVENTS.BOARD_MEMBER_DELETED.message({ memberName: 'Pat Lee' }),
      'Board member "Pat Lee" has been removed from the community.'
    );
    assert.equal(
      EVENTS.BOARD_MEMBER_INVITED.message({ memberName: 'pat', hoaName: 'Riverside' }),
      'pat has been invited to join the board for Riverside.'
    );
    assert.equal(
      EVENTS.BOARD_MEMBER_INVITED.message({ memberName: 'pat', hoaName: 'Riverside', isResend: true }),
      'Board member invitation resent to pat for Riverside.'
    );
    assert.equal(
      EVENTS.BOARD_MEMBER_INVITE_ACCEPTED.message({ memberName: 'Pat Lee', hoaName: 'Riverside' }),
      'Pat Lee has accepted the board member invitation for Riverside.'
    );
  });

  it('keeps extra recipients such as the inviter when merging with board ids', () => {
    const boardA = '507f1f77bcf86cd799439011';
    const boardB = '507f1f77bcf86cd799439012';
    const inviter = boardA;
    assert.deepEqual(
      dedupeIds([boardA, boardB, inviter]).sort(),
      [boardA, boardB].sort()
    );
  });
});
