const test = require('node:test');
const assert = require('node:assert/strict');

const { signupSchema } = require('../validators/auth.validator');

const ROLE_ID = '507f1f77bcf86cd799439011';

function buildSignupPayload(overrides = {}) {
  return {
    email: 'alan.susan@example.com',
    password: 'EncryptedPass1!',
    confirmPassword: 'EncryptedPass1!',
    firstName: 'Alan',
    lastName: 'Susan',
    phone: '(512) 555-1234',
    roleId: ROLE_ID,
    ...overrides,
  };
}

test('signup schema accepts ampersands in first and last names for self-serve roles', () => {
  const result = signupSchema.validate(
    buildSignupPayload({
      firstName: 'Alan & Susan',
      lastName: 'Smith & Jones',
    })
  );
  assert.equal(result.error, undefined);
});

test('signup schema rejects invalid characters in names', () => {
  const atResult = signupSchema.validate(
    buildSignupPayload({
      firstName: 'Alan@Susan',
    })
  );
  assert.ok(atResult.error);
  assert.match(atResult.error.message, /invalid characters/i);
});

test('signup schema rejects ampersand not after a letter', () => {
  const result = signupSchema.validate(
    buildSignupPayload({
      firstName: '&Susan',
    })
  );
  assert.ok(result.error);
  assert.match(result.error.message, /invalid characters/i);
});
