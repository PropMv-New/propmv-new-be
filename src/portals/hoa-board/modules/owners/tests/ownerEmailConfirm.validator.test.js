const test = require('node:test');
const assert = require('node:assert/strict');

const routedValidator = require('../validators/owner.validator');
const legacyValidator = require('../validators/createOwner.validator');

function buildPayload(overrides = {}) {
  return {
    firstName: 'Jane',
    lastName: 'Owner',
    email: 'jane.owner@example.com',
    phone: '(555) 123-4567',
    hasUnits: false,
    sendInvite: true,
    ...overrides,
  };
}

function validateWithEnv(schema, payload, envValue) {
  const previous = process.env.EMAIL_REQUIRE_EMAIL_CONFIRM;
  try {
    if (envValue == null) {
      delete process.env.EMAIL_REQUIRE_EMAIL_CONFIRM;
    } else {
      process.env.EMAIL_REQUIRE_EMAIL_CONFIRM = envValue;
    }
    return schema.validate(payload);
  } finally {
    if (previous == null) {
      delete process.env.EMAIL_REQUIRE_EMAIL_CONFIRM;
    } else {
      process.env.EMAIL_REQUIRE_EMAIL_CONFIRM = previous;
    }
  }
}

test('owner validators allow missing emailConfirm unless EMAIL_REQUIRE_EMAIL_CONFIRM is enabled', () => {
  for (const schema of [routedValidator.createOwnerSchema, legacyValidator.createOwnerSchema]) {
    const relaxed = validateWithEnv(schema, buildPayload(), undefined);
    assert.equal(relaxed.error, undefined);

    const strict = validateWithEnv(schema, buildPayload(), 'true');
    assert.ok(strict.error);
    assert.match(strict.error.message, /Re-enter the email address/i);
  }
});

test('owner validators accept ampersands in first and last names', () => {
  const payload = buildPayload({
    firstName: 'Alan & Susan',
    lastName: 'Smith & Jones',
    emergencyContact: {
      firstName: 'Alan & Susan',
      lastName: 'Contact',
      phone: '(555) 987-6543',
    },
  });
  const result = validateWithEnv(routedValidator.createOwnerSchema, payload, undefined);
  assert.equal(result.error, undefined);
});

test('owner validators reject invalid emergency contact names', () => {
  const payload = buildPayload({
    emergencyContact: {
      firstName: '123 Bad',
      lastName: 'Contact',
      phone: '(512) 987-6543',
    },
  });
  const result = validateWithEnv(routedValidator.createOwnerSchema, payload, undefined);
  assert.ok(result.error);
  assert.match(result.error.message, /invalid characters/i);
});

test('owner validators accept optional phone and treat whitespace as empty', () => {
  for (const schema of [routedValidator.createOwnerSchema, legacyValidator.createOwnerSchema]) {
    const missing = validateWithEnv(schema, buildPayload({ phone: undefined }), undefined);
    assert.equal(missing.error, undefined);

    const empty = validateWithEnv(schema, buildPayload({ phone: '' }), undefined);
    assert.equal(empty.error, undefined);

    const whitespace = validateWithEnv(schema, buildPayload({ phone: '   ' }), undefined);
    assert.equal(whitespace.error, undefined);

    const invalid = validateWithEnv(schema, buildPayload({ phone: 'not-a-phone' }), undefined);
    assert.ok(invalid.error);
    assert.match(invalid.error.message, /phone/i);
  }
});

test('owner validators still reject mismatched emailConfirm when provided', () => {
  for (const schema of [routedValidator.createOwnerSchema, legacyValidator.createOwnerSchema]) {
    const result = validateWithEnv(
      schema,
      buildPayload({ emailConfirm: 'other@example.com' }),
      undefined
    );
    assert.ok(result.error);
    assert.match(result.error.message, /Email addresses do not match/i);
  }
});
