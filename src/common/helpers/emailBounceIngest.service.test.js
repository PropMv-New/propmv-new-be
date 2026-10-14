const test = require('node:test');
const assert = require('node:assert/strict');

process.env.EMAIL_VALIDATION_LOG = 'false';
process.env.EMAIL_SUPPRESSION_ENABLED = 'false';

const {
  extractBounceRecipient,
  looksLikePermanentBounce,
  ingestBounceNotification,
} = require('./emailBounceIngest.service');

const HOSTINGER_DSN = `
This is the mail system at host relay.mailchannels.net.

I'm sorry to have to inform you that your message could not
be delivered to one or more recipients.

<pawardurva406@gmail.com>: host gmail-smtp-in.l.google.com[142.250.107.27]
    said: 550-5.1.1 The email account that you tried to reach does not exist.
`;

test('looksLikePermanentBounce detects 550 5.1.1', () => {
  assert.equal(looksLikePermanentBounce(HOSTINGER_DSN), true);
  assert.equal(looksLikePermanentBounce('Your invoice is ready'), false);
});

test('extractBounceRecipient parses Hostinger/Mailchannels DSN', () => {
  const email = extractBounceRecipient(HOSTINGER_DSN);
  assert.equal(email, 'pawardurva406@gmail.com');
});

test('extractBounceRecipient prefers Final-Recipient header', () => {
  const text = `
Final-Recipient: rfc822; bad.user@example.com
Action: failed
Status: 5.1.1
`;
  assert.equal(extractBounceRecipient(text), 'bad.user@example.com');
});

test('extractBounceRecipient does not suppress arbitrary body emails', () => {
  const text = `
Delivery failed with 550 5.1.1
Please contact support@propmv.com or help@example.org for assistance.
`;
  assert.equal(extractBounceRecipient(text), null);
});

test('ingestBounceNotification suppresses permanent bounce recipient', async () => {
  // Suppression writes are skipped when EMAIL_SUPPRESSION_ENABLED=false,
  // but parsing + decision path should still report the email.
  const result = await ingestBounceNotification({
    subject: 'Undelivered Mail Returned to Sender',
    text: HOSTINGER_DSN,
    source: 'test',
  });
  assert.equal(result.email, 'pawardurva406@gmail.com');
  assert.equal(result.suppressed, false);
  assert.equal(result.reason, 'suppressed');
});
