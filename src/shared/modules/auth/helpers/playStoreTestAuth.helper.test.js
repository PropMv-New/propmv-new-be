const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePlayStoreTestAccounts,
  isPlayStoreTestAuthEnabled,
  isPlayStoreTestAccount,
  matchesPlayStoreTestOtp,
  shouldSkipOtpDelivery,
} = require('./playStoreTestAuth.helper');

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

describe('playStoreTestAuth.helper', () => {
  afterEach(() => {
    delete process.env.PLAY_STORE_TEST_AUTH_ENABLED;
    delete process.env.PLAY_STORE_TEST_OTP;
    delete process.env.PLAY_STORE_TEST_ACCOUNTS;
  });

  it('is disabled unless PLAY_STORE_TEST_AUTH_ENABLED=true', () => {
    withEnv({ PLAY_STORE_TEST_AUTH_ENABLED: 'false', PLAY_STORE_TEST_OTP: '000000' }, () => {
      assert.equal(isPlayStoreTestAuthEnabled(), false);
      assert.equal(isPlayStoreTestAccount('board@propmv.com'), false);
      assert.equal(matchesPlayStoreTestOtp('board@propmv.com', '000000'), false);
    });
  });

  it('accepts master OTP only for approved reviewer emails when enabled', () => {
    withEnv({
      PLAY_STORE_TEST_AUTH_ENABLED: 'true',
      PLAY_STORE_TEST_OTP: '000000',
    }, () => {
      assert.equal(isPlayStoreTestAccount('board@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('test_board@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('test_vendor@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('qa.board@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('qa2.board@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('qa2.owner@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('qa.owner.unassigned@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('qa.vendor@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('qa.tenant@propmv.com'), true);
      assert.equal(isPlayStoreTestAccount('qa.landlord@propmv.com'), true);
      assert.equal(matchesPlayStoreTestOtp('board@propmv.com', '000000'), true);
      assert.equal(matchesPlayStoreTestOtp('test_owner@propmv.com', '000000'), true);
      assert.equal(matchesPlayStoreTestOtp('test_vendor@propmv.com', '000000'), true);
      assert.equal(matchesPlayStoreTestOtp('qa.owner.single@propmv.com', '000000'), true);
      assert.equal(matchesPlayStoreTestOtp('qa.owner.co2@propmv.com', '000000'), true);
      assert.equal(matchesPlayStoreTestOtp('qa.landlord@propmv.com', '000000'), true);
      assert.equal(matchesPlayStoreTestOtp('normal-user@gmail.com', '000000'), false);
      assert.equal(matchesPlayStoreTestOtp('board@propmv.com', '123456'), false);
    });
  });

  it('supports custom reviewer account list from env', () => {
    withEnv({
      PLAY_STORE_TEST_AUTH_ENABLED: 'true',
      PLAY_STORE_TEST_OTP: '000000',
      PLAY_STORE_TEST_ACCOUNTS: 'reviewer@example.com, reviewer2@example.com',
    }, () => {
      assert.deepEqual(parsePlayStoreTestAccounts(), ['reviewer@example.com', 'reviewer2@example.com']);
      assert.equal(isPlayStoreTestAccount('reviewer@example.com'), true);
      assert.equal(isPlayStoreTestAccount('board@propmv.com'), false);
    });
  });

  it('skips OTP delivery only for approved reviewer accounts', () => {
    withEnv({
      PLAY_STORE_TEST_AUTH_ENABLED: 'true',
      PLAY_STORE_TEST_OTP: '000000',
    }, () => {
      assert.equal(shouldSkipOtpDelivery('owner@propmv.com'), true);
      assert.equal(shouldSkipOtpDelivery('someone@gmail.com'), false);
    });
  });

  beforeEach(() => {
    delete process.env.PLAY_STORE_TEST_AUTH_ENABLED;
    delete process.env.PLAY_STORE_TEST_OTP;
    delete process.env.PLAY_STORE_TEST_ACCOUNTS;
  });
});
