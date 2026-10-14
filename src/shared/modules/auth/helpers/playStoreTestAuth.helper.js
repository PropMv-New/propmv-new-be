const { normalizeUserEmail } = require('../../users/helpers/userIdentityValidation');

const DEFAULT_PLAY_STORE_TEST_ACCOUNTS = [
  'board@propmv.com',
  'owner@propmv.com',
  'landlord@propmv.com',
  'tenants@propmv.com',
  'propertymanager@propmv.com',
  'test_board@propmv.com',
  'test_owner@propmv.com',
  'test_landlord@propmv.com',
  'test_tenants@propmv.com',
  'test_propertymanager@propmv.com',
  'test_vendor@propmv.com',
  'qa.board@propmv.com',
  'qa.board2@propmv.com',
  'qa2.board@propmv.com',
  'qa2.owner@propmv.com',
  'qa.owner.single@propmv.com',
  'qa.owner.co1@propmv.com',
  'qa.owner.co2@propmv.com',
  'qa.owner.co3@propmv.com',
  'qa.owner.unassigned@propmv.com',
  'qa.vendor@propmv.com',
  'qa.tenant@propmv.com',
  'qa.landlord@propmv.com',
];

function isTruthyEnv(value) {
  return ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parsePlayStoreTestAccounts() {
  const raw = process.env.PLAY_STORE_TEST_ACCOUNTS;
  const source = raw && String(raw).trim()
    ? String(raw).split(',')
    : DEFAULT_PLAY_STORE_TEST_ACCOUNTS;
  return source
    .map((email) => normalizeUserEmail(email))
    .filter(Boolean);
}

function isPlayStoreTestAuthEnabled() {
  return isTruthyEnv(process.env.PLAY_STORE_TEST_AUTH_ENABLED);
}

function isPlayStoreTestAccount(email) {
  if (!isPlayStoreTestAuthEnabled()) return false;
  const normalized = normalizeUserEmail(email);
  if (!normalized) return false;
  return parsePlayStoreTestAccounts().includes(normalized);
}

function getPlayStoreTestOtp() {
  return String(process.env.PLAY_STORE_TEST_OTP || '').trim();
}

function matchesPlayStoreTestOtp(email, otp) {
  if (!isPlayStoreTestAccount(email)) return false;
  const masterOtp = getPlayStoreTestOtp();
  if (!masterOtp) return false;
  return String(otp || '').trim() === masterOtp;
}

function shouldSkipOtpDelivery(email) {
  return isPlayStoreTestAccount(email);
}

module.exports = {
  DEFAULT_PLAY_STORE_TEST_ACCOUNTS,
  parsePlayStoreTestAccounts,
  isPlayStoreTestAuthEnabled,
  isPlayStoreTestAccount,
  getPlayStoreTestOtp,
  matchesPlayStoreTestOtp,
  shouldSkipOtpDelivery,
};
