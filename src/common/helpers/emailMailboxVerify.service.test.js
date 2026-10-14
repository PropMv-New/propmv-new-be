const test = require('node:test');
const assert = require('node:assert/strict');

process.env.EMAIL_VALIDATION_LOG = 'false';
process.env.EMAIL_SUPPRESSION_ENABLED = 'false';
process.env.EMAIL_MAILBOX_VERIFY_ENABLED = 'true';
process.env.EMAIL_MAILBOX_VERIFY_PROVIDER = 'custom';
process.env.EMAIL_MAILBOX_VERIFY_URL = 'https://example.invalid/verify?email={{email}}';
process.env.EMAIL_MAILBOX_VERIFY_ON_ERROR = 'allow';
process.env.EMAIL_MAILBOX_VERIFY_TIMEOUT_MS = '200';

const {
  clearMailboxVerifyCache,
  isEnabled,
  verifyMailbox,
} = require('./emailMailboxVerify.service');

test('isEnabled is true when custom URL configured', () => {
  assert.equal(isEnabled(), true);
});

test('verifyMailbox fails open on provider error when ON_ERROR=allow', async () => {
  clearMailboxVerifyCache();
  process.env.EMAIL_MAILBOX_VERIFY_ON_ERROR = 'allow';
  const result = await verifyMailbox('someone@gmail.com');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'error_allowed');
});

test('verifyMailbox fails closed on provider error when ON_ERROR=reject', async () => {
  clearMailboxVerifyCache();
  process.env.EMAIL_MAILBOX_VERIFY_ON_ERROR = 'reject';
  const result = await verifyMailbox('someone@gmail.com');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
});
