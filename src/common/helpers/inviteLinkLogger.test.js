const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldLogInviteUrl } = require('./inviteLinkLogger');

test('shouldLogInviteUrl is true when email sending is disabled', () => {
  assert.equal(
    shouldLogInviteUrl('invite', {
      EMAIL_SENDING_ENABLED: 'false',
      NODE_ENV: 'production',
    }),
    true
  );
});

test('shouldLogInviteUrl is true when invite template is disabled', () => {
  assert.equal(
    shouldLogInviteUrl('invite', {
      EMAIL_SENDING_ENABLED: 'true',
      EMAIL_TEMPLATE_INVITE_ENABLED: 'false',
      NODE_ENV: 'production',
    }),
    true
  );
});

test('shouldLogInviteUrl is false in production when email and template are enabled', () => {
  assert.equal(
    shouldLogInviteUrl('invite', {
      EMAIL_SENDING_ENABLED: 'true',
      EMAIL_TEMPLATE_INVITE_ENABLED: 'true',
      NODE_ENV: 'production',
      LOG_INVITE_URLS: 'false',
    }),
    false
  );
});
