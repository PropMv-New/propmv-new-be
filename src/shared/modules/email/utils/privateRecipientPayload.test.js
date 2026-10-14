const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPrivateRecipientPayload,
  splitEmailAddresses,
  uniqueEmails,
} = require('./privateRecipientPayload');

describe('privateRecipientPayload', () => {
  it('splitEmailAddresses handles comma lists and arrays', () => {
    assert.deepEqual(splitEmailAddresses('a@x.com, b@x.com'), ['a@x.com', 'b@x.com']);
    assert.deepEqual(splitEmailAddresses(['a@x.com', 'b@x.com, c@x.com']), [
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  it('uniqueEmails dedupes case-insensitively', () => {
    assert.deepEqual(uniqueEmails(['A@x.com', 'a@x.com', 'b@x.com']), ['A@x.com', 'b@x.com']);
  });

  it('single recipient stays in To', () => {
    assert.deepEqual(
      buildPrivateRecipientPayload({
        to: 'owner@example.com',
        envelopeTo: 'board@example.com',
      }),
      {
        to: 'owner@example.com',
        cc: null,
        bcc: null,
        recipientCount: 1,
      }
    );
  });

  it('multiple recipients move to BCC with sender envelope in To', () => {
    assert.deepEqual(
      buildPrivateRecipientPayload({
        to: 'a@example.com, b@example.com, c@example.com',
        envelopeTo: 'board@example.com',
      }),
      {
        to: 'board@example.com',
        cc: null,
        bcc: 'a@example.com, b@example.com, c@example.com',
        recipientCount: 3,
      }
    );
  });

  it('merges to/cc/bcc and hides everyone except envelope', () => {
    const result = buildPrivateRecipientPayload({
      to: 'a@example.com',
      cc: 'b@example.com',
      bcc: 'c@example.com',
      envelopeTo: 'sender@example.com',
    });
    assert.equal(result.to, 'sender@example.com');
    assert.equal(result.cc, null);
    assert.equal(result.bcc, 'a@example.com, b@example.com, c@example.com');
    assert.equal(result.recipientCount, 3);
  });

  it('falls back to first recipient as To when envelope missing', () => {
    const result = buildPrivateRecipientPayload({
      to: 'a@example.com, b@example.com',
    });
    assert.equal(result.to, 'a@example.com');
    assert.equal(result.bcc, 'b@example.com');
    assert.equal(result.recipientCount, 2);
  });
});
