const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertInvitationEmailMatchesUser,
  normalizeInviteEmail,
} = require('./portalInvitation.service');

describe('portal invitation email change validation', () => {
  test('normalizeInviteEmail lowercases and trims', () => {
    assert.equal(normalizeInviteEmail('  Owner@Example.COM  '), 'owner@example.com');
  });

  test('assertInvitationEmailMatchesUser passes when invite email matches user email', () => {
    assert.doesNotThrow(() =>
      assertInvitationEmailMatchesUser(
        { inviteeEmail: 'owner@example.com' },
        { email: 'Owner@Example.com' },
      ),
    );
  });

  test('assertInvitationEmailMatchesUser rejects when account email changed after invite', () => {
    assert.throws(
      () =>
        assertInvitationEmailMatchesUser(
          { inviteeEmail: 'old@example.com' },
          { email: 'new@example.com' },
        ),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /no longer valid/i);
        return true;
      },
    );
  });
});
