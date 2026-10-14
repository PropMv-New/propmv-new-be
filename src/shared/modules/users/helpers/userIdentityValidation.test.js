const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUserEmail,
  normalizeUserPhone,
  DUPLICATE_EMAIL_MESSAGE,
  DUPLICATE_PHONE_MESSAGE,
} = require('./userIdentityValidation');

describe('userIdentityValidation', () => {
  describe('normalizeUserEmail', () => {
    it('trims and lowercases email', () => {
      assert.equal(normalizeUserEmail('  User@Example.COM '), 'user@example.com');
    });

    it('returns empty string for blank input', () => {
      assert.equal(normalizeUserEmail(''), '');
      assert.equal(normalizeUserEmail(null), '');
    });
  });

  describe('normalizeUserPhone', () => {
    it('uses last 10 digits for longer numbers', () => {
      assert.equal(normalizeUserPhone('+1 (555) 123-4567'), '5551234567');
      assert.equal(normalizeUserPhone('15551234567'), '5551234567');
    });

    it('returns empty string for blank input', () => {
      assert.equal(normalizeUserPhone(''), '');
      assert.equal(normalizeUserPhone(null), '');
    });
  });

  it('exports consistent duplicate messages', () => {
    assert.match(DUPLICATE_EMAIL_MESSAGE, /email/i);
    assert.match(DUPLICATE_PHONE_MESSAGE, /phone/i);
  });
});
